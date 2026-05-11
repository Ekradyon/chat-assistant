# ============================================================================
# deploy.ps1 -- Sube el ZIP del chat-assistant a Models.WebPackage de Airflows.
#
# Clonado del patron pipeline-flow/deploy.ps1 (validado en produccion ANH).
# 5 llamadas HTTP:
#   1. POST /graphql                                          -> mutation login -> access_token
#   2. POST /graphql Models_WebPackageList(name)              -> id (si no pasas -WebPackageId)
#   3. POST /graphql Models_WebPackageUpdate(built=false)     -> invalida build cacheado
#   4. POST /document/Models/WebPackage/{id}/package/contents -> upload multipart -> oid
#   5. POST /graphql Models_WebPackageUpdate(package={oid..}) -> commit final
#
# Uso recomendado:
#   $env:AIRFLOWS_PASSWORD = 'XXXX'
#   .\deploy.ps1 -Username llopez -Password $env:AIRFLOWS_PASSWORD
#
# Uso interactivo:
#   .\deploy.ps1
#     -- pide usuario y password con prompts.
#
# Parametros:
#   -BaseUrl          URL Airflows. Default: https://anh-pro.flows.ninja
#   -ZipPath          Ruta al ZIP. Default: .\chat-assistant.zip
#   -WebPackageName   Default: chat-assistant
#   -WebPackageType   STATIC | NODE. Default: STATIC (Alpine.js puro)
#   -WebPackageId     id de Models.WebPackage. Si no pasas, lo descubre por nombre.
#   -Username         Usuario admin Airflows.
#   -Password         Password.
#   -Build            Si pasas, ejecuta build.ps1 antes de subir.
# ============================================================================

[CmdletBinding()]
param(
    [string] $BaseUrl = 'https://anh-pro.flows.ninja',
    [string] $ZipPath = '',
    [string] $WebPackageName = 'chat-assistant',
    [ValidateSet('STATIC','NODE')]
    [string] $WebPackageType = 'STATIC',
    [int]    $WebPackageId = 0,
    [string] $Username = '',
    [string] $Password = '',
    [switch] $Build
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $ZipPath) { $ZipPath = Join-Path $Root 'chat-assistant.zip' }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Build opcional
if ($Build) {
    Write-Host "==> Ejecutando build.ps1..." -ForegroundColor Cyan
    & (Join-Path $Root 'build.ps1')
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 fallo." }
}

if (-not (Test-Path -LiteralPath $ZipPath)) {
    throw "ZIP no encontrado en $ZipPath. Corre primero .\build.ps1 o pasa -ZipPath."
}

$zipBytes = (Get-Item -LiteralPath $ZipPath).Length
Write-Host "ZIP: $ZipPath ($zipBytes bytes)" -ForegroundColor DarkGray

# Credenciales
if (-not $Username) { $Username = Read-Host 'Usuario Airflows' }
if (-not $Password) {
    $secure = Read-Host 'Password' -AsSecureString
    $Password = [System.Net.NetworkCredential]::new('', $secure).Password
}

# Login
Write-Host "==> Login en $BaseUrl/graphql..." -ForegroundColor Cyan
$escUser = $Username.Replace('"','\"')
$escPass = $Password.Replace('"','\"')
$loginQuery = '{"query":"mutation{login(username:\"' + $escUser + '\",password:\"' + $escPass + '\",verificationCode:\"\")}"}'
$loginResp = Invoke-RestMethod `
    -Uri "$BaseUrl/graphql" `
    -Method POST `
    -ContentType 'application/json' `
    -Headers @{ 'accept' = 'application/graphql-response+json, application/json' } `
    -Body $loginQuery

if (-not $loginResp.data.login) {
    Write-Host ($loginResp | ConvertTo-Json -Depth 5) -ForegroundColor Red
    throw "Login fallo: no se recibio access_token."
}
$accessToken = $loginResp.data.login
Write-Host "    Login OK. Token len=$($accessToken.Length)" -ForegroundColor Green

# Discover WebPackage id
if ($WebPackageId -le 0) {
    Write-Host "==> Descubriendo id del WebPackage '$WebPackageName'..." -ForegroundColor Cyan
    $discoverQuery = @{
        query = 'query($name:String!){ Models_WebPackageList(where:{name:{EQ:$name}}){ id name type } }'
        variables = @{ name = $WebPackageName }
    } | ConvertTo-Json -Depth 5 -Compress
    $discoverResp = Invoke-RestMethod `
        -Uri "$BaseUrl/graphql" `
        -Method POST `
        -ContentType 'application/json' `
        -Headers @{ 'authorization' = "Bearer $accessToken" } `
        -Body $discoverQuery
    if ($discoverResp.errors) {
        Write-Host ($discoverResp | ConvertTo-Json -Depth 5) -ForegroundColor Red
        throw "Discovery fallo. Revisa permisos del usuario (necesita SELECT en Models.WebPackage)."
    }
    $matches = @($discoverResp.data.Models_WebPackageList)
    if ($matches.Count -eq 0) {
        throw "WebPackage '$WebPackageName' no existe. Crealo en /admin/Models.WebPackage primero (con type=$WebPackageType) y vuelve a correr."
    }
    if ($matches.Count -gt 1) {
        Write-Host ($matches | Format-Table | Out-String) -ForegroundColor Yellow
        throw "Hay $($matches.Count) WebPackages con name='$WebPackageName'. Especifica -WebPackageId."
    }
    $WebPackageId = [int]$matches[0].id
    Write-Host "    Encontrado: id=$WebPackageId type=$($matches[0].type)" -ForegroundColor Green
}

# Invalidar build cacheado
Write-Host "==> Invalidando build (built=false)..." -ForegroundColor Cyan
$invalidateQuery = @{
    query = 'mutation Update($id:Int! $name:String! $type:Models_WebPackageTypeEnumType! $built:Boolean){ result: Models_WebPackageUpdate(where:{id:{EQ:$id}} entity:{name:$name type:$type built:$built}){ id } }'
    variables = @{
        id    = $WebPackageId
        name  = $WebPackageName
        type  = $WebPackageType
        built = $false
    }
    operationName = 'Update'
} | ConvertTo-Json -Depth 5 -Compress
$invalidateResp = Invoke-RestMethod `
    -Uri "$BaseUrl/graphql" `
    -Method POST `
    -ContentType 'application/json' `
    -Headers @{ 'authorization' = "Bearer $accessToken" } `
    -Body $invalidateQuery
if ($invalidateResp.errors) {
    Write-Host ($invalidateResp | ConvertTo-Json -Depth 5) -ForegroundColor Red
    throw "Invalidate fallo."
}
Write-Host "    OK" -ForegroundColor Green

# Upload ZIP
Write-Host "==> Subiendo ZIP al endpoint REST..." -ForegroundColor Cyan
$uploadUri = "$BaseUrl/document/Models/WebPackage/$WebPackageId/package/contents?access_token=$accessToken"
try {
    $uploadResp = Invoke-RestMethod `
        -Uri $uploadUri `
        -Method POST `
        -Form @{ file = Get-Item -LiteralPath $ZipPath } `
        -Headers @{
            'Accept' = '*/*'
            'User-Agent' = 'Mozilla/5.0 deploy.ps1'
        }
} catch {
    Write-Host "Upload fallo: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host $reader.ReadToEnd() -ForegroundColor Red
    }
    throw
}

$fileOid = $null
$fileSize = $zipBytes
$fileName = Split-Path -Leaf $ZipPath
$fileType = 'application/zip'
if ($uploadResp -is [int] -or $uploadResp -is [long]) {
    $fileOid = [int64]$uploadResp
} elseif ($uploadResp -is [string] -and $uploadResp -match '^\s*(\d+)\s*$') {
    $fileOid = [int64]$Matches[1]
} elseif ($uploadResp.oid) {
    $fileOid = [int64]$uploadResp.oid
    if ($uploadResp.size) { $fileSize = [int64]$uploadResp.size }
    if ($uploadResp.name) { $fileName = $uploadResp.name }
    if ($uploadResp.type) { $fileType = $uploadResp.type }
}
if (-not $fileOid) {
    Write-Host ($uploadResp | ConvertTo-Json -Depth 5) -ForegroundColor Red
    throw "Upload no devolvio un OID interpretable."
}
Write-Host "    OK. OID=$fileOid size=$fileSize name=$fileName" -ForegroundColor Green

# Commit final
Write-Host "==> Vinculando OID al WebPackage..." -ForegroundColor Cyan
$commitQuery = @{
    query = 'mutation Update($id:Int! $name:String! $type:Models_WebPackageTypeEnumType! $package:Models_DocumentTypeInputType $built:Boolean){ result: Models_WebPackageUpdate(where:{id:{EQ:$id}} entity:{name:$name type:$type package:$package built:$built}){ id } }'
    variables = @{
        id    = $WebPackageId
        name  = $WebPackageName
        type  = $WebPackageType
        package = @{
            name = $fileName
            size = $fileSize
            type = $fileType
            oid  = $fileOid
            text = $null
        }
        built = $false
    }
    operationName = 'Update'
} | ConvertTo-Json -Depth 6 -Compress
$commitResp = Invoke-RestMethod `
    -Uri "$BaseUrl/graphql" `
    -Method POST `
    -ContentType 'application/json' `
    -Headers @{ 'authorization' = "Bearer $accessToken" } `
    -Body $commitQuery
if ($commitResp.errors) {
    Write-Host ($commitResp | ConvertTo-Json -Depth 5) -ForegroundColor Red
    throw "Commit fallo."
}
Write-Host "    OK" -ForegroundColor Green

# Verificacion liviana
Write-Host ""
Write-Host "==> Verificando endpoint..." -ForegroundColor Cyan
Start-Sleep -Seconds 2

$probes = @(
    @{ path = "/$WebPackageName/";                expectMatch = '<title>Asistente Hidrocarburos' }
    @{ path = "/$WebPackageName/index.html";      expectMatch = '<title>Asistente Hidrocarburos' }
    @{ path = "/$WebPackageName/assets/app.css";  expectMatch = $null }
    @{ path = "/$WebPackageName/assets/app.js";   expectMatch = 'function chatAssistant' }
    @{ path = "/$WebPackageName/assets/data.js";  expectMatch = 'window.__CA_DATA__' }
    @{ path = "/$WebPackageName/lib/alpine.min.js"; expectMatch = $null }
)
$failures = 0
foreach ($p in $probes) {
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl$($p.path)" -Method GET -SkipHttpErrorCheck -MaximumRedirection 0
        $code = $resp.StatusCode
        $body = $resp.Content
        $bodyOk = $true
        if ($p.expectMatch) {
            $bodyOk = $body -and ($body -match [regex]::Escape($p.expectMatch))
        }
        if ($code -eq 200 -and $bodyOk) {
            Write-Host ("    {0,3} {1,-50} OK" -f $code, $p.path) -ForegroundColor Green
        } elseif ($code -eq 200 -and -not $bodyOk) {
            Write-Host ("    {0,3} {1,-50} BODY NO COINCIDE" -f $code, $p.path) -ForegroundColor Yellow
            $failures++
        } else {
            Write-Host ("    {0,3} {1,-50} FAIL" -f $code, $p.path) -ForegroundColor Red
            $failures++
        }
    } catch {
        Write-Host ("    ERR {0,-50} {1}" -f $p.path, $_.Exception.Message) -ForegroundColor Red
        $failures++
    }
}

# Verificar endpoint backend (orquestador)
Write-Host ""
Write-Host "==> Verificando endpoint backend (invocarAgenteHidrocarburos)..." -ForegroundColor Cyan
try {
    $apiUri = "$BaseUrl/functions/IaCore.invocarAgenteHidrocarburos"
    $apiBody = @{ p_pregunta = "ping" } | ConvertTo-Json -Compress
    $apiResp = Invoke-WebRequest -Uri $apiUri `
        -Method POST `
        -ContentType 'application/json' `
        -Headers @{ 'authorization' = "Bearer $accessToken" } `
        -Body $apiBody `
        -SkipHttpErrorCheck
    $apiCode = $apiResp.StatusCode
    if ($apiCode -eq 200) {
        Write-Host ("    {0,3} POST /functions/IaCore.invocarAgenteHidrocarburos  OK" -f $apiCode) -ForegroundColor Green
    } else {
        Write-Host ("    {0,3} POST /functions/IaCore.invocarAgenteHidrocarburos  FAIL" -f $apiCode) -ForegroundColor Red
        $failures++
    }
} catch {
    Write-Host ("    ERR /functions/IaCore.invocarAgenteHidrocarburos  {0}" -f $_.Exception.Message) -ForegroundColor Red
    $failures++
}

if ($failures -gt 0) {
    Write-Host ""
    Write-Host "[WARN] $failures probe(s) fallaron. Posibles causas:" -ForegroundColor Yellow
    Write-Host "  - Airflows aun esta procesando el zip (esperar 30s y reintentar)." -ForegroundColor Yellow
    Write-Host "  - El zip no tiene index.html en la raiz de chat-assistant/." -ForegroundColor Yellow
    Write-Host "  - invocarAgenteHidrocarburos no tiene httpEnabled o el role no tiene execute." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[OK] Deploy completado." -ForegroundColor Green
Write-Host "  WebPackage id : $WebPackageId"
Write-Host "  type          : $WebPackageType"
Write-Host "  ZIP           : $ZipPath ($fileSize bytes, OID=$fileOid)"
Write-Host ""
Write-Host "Acceso:" -ForegroundColor Cyan
Write-Host "  $BaseUrl/$WebPackageName/?access_token=<JWT>"
Write-Host ""
Write-Host "Para usuarios: asignar rol App_ChatAssistant en /admin/Seguridad.Usuarios" -ForegroundColor Cyan
