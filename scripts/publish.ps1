param([string]$RepositoryName = 'photo-picker')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if ($RepositoryName -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Некорректное имя репозитория.' }
function Invoke-Native([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Ошибка команды $Program (код $LASTEXITCODE)." }
}
$owner = & gh api user --jq .login
if ($LASTEXITCODE -ne 0 -or !$owner) { throw 'Сначала войдите в GitHub: gh auth login' }
$repo = "$owner/$RepositoryName"
if (!(Test-Path -LiteralPath '.git')) { Invoke-Native git @('init', '-b', 'main') }
$remotes = & git remote
if ($remotes -contains 'origin') {
    $remoteUrl = & git remote get-url origin
    if ($remoteUrl -notin @("https://github.com/$repo.git", "https://github.com/$repo", "git@github.com:$repo.git")) { throw "Origin указывает на другой репозиторий: $remoteUrl" }
} else {
    # Never attach to a pre-existing unrelated repository when creating the site.
    Invoke-Native gh @('repo', 'create', $repo, '--public', '--source', '.', '--remote', 'origin', '--description', 'Фотографии запчастей по артикулам: Google Диск и eBay')
}
Invoke-Native git @('add', '--', '.')
& git diff --cached --quiet
if ($LASTEXITCODE -eq 1) { Invoke-Native git @('commit', '-m', 'Build photo picker for Drive and eBay') }
elseif ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить изменения Git.' }
Invoke-Native git @('push', '-u', 'origin', 'main')
$pageCommit = & git subtree split --prefix public HEAD
if ($LASTEXITCODE -ne 0 -or !$pageCommit) { throw 'Не удалось подготовить ветку GitHub Pages.' }
Invoke-Native git @('push', 'origin', "${pageCommit}:refs/heads/gh-pages")
& gh api "repos/$repo/pages" --silent 2>$null
$exists = $LASTEXITCODE -eq 0
$method = if ($exists) { 'PUT' } else { 'POST' }
# Explicit source prevents a dependency-installing Actions workflow.
Invoke-Native gh @('api', '--method', $method, "repos/$repo/pages", '-f', 'build_type=legacy', '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/')
Invoke-Native gh @('api', "repos/$repo/pages", '--jq', '{url: .html_url, status: .status}')
