# Runs the test suite on this machine WITHOUT Node, inside headless Microsoft Edge.
#
#   powershell -ExecutionPolicy Bypass -File tests\run-local.ps1
#
# Same tests as tests/run.js. The only difference: Edge has no Node crypto, so
# encryption runs on a stand-in cipher here and the few tests that check real
# AES are skipped (they run on GitHub Actions). Exit code 1 = something failed.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object Text.UTF8Encoding($false)

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Host "Microsoft Edge was not found - cannot run the tests locally."; exit 2 }

function Read-Text($rel) { [IO.File]::ReadAllText((Join-Path $root $rel), $utf8) }

$cases = @(Get-ChildItem (Join-Path $root "tests\cases") -Filter *.js | Sort-Object Name | ForEach-Object {
  [ordered]@{ name = $_.Name; src = [IO.File]::ReadAllText($_.FullName, $utf8) }
})
$payload = [ordered]@{
  harness = Read-Text "tests\lib\harness.js"
  update  = Read-Text "scripts\update.js"
  mirror  = Read-Text "mirror\index.js"
  config  = Read-Text "config.json"
  fixture = Read-Text "tests\fixtures\v1.0-boards.json"
  cases   = $cases
} | ConvertTo-Json -Compress -Depth 5

$page = @'
<!doctype html><meta charset="utf-8"><title>tests</title><pre id="out">pending</pre>
<script>window.P = __PAYLOAD__;</script>
<script>
(async () => {
  let out;
  try {
    const P = window.P;
    const ENV = {
      isNode: false, crypto: null, Buffer: null,
      sources: { update: P.update, mirror: P.mirror, config: P.config },
      fixtures: { v10: JSON.parse(P.fixture) },
    };
    const T = new Function("ENV", P.harness)(ENV);
    for (const c of P.cases) new Function("T", c.src)(T);
    const r = await T.run();
    out = { ok: r.failed === 0, text: T.report(r) };
  } catch (e) {
    out = { ok: false, text: "The test runner itself crashed: " + (e && e.stack ? e.stack : e) };
  }
  document.getElementById("out").textContent = JSON.stringify(out);
})();
</script>
'@

$tmp = Join-Path $env:TEMP "leaderboard-tests"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$html = Join-Path $tmp "run.html"
$dom = Join-Path $tmp "dom.txt"
[IO.File]::WriteAllText($html, $page.Replace("__PAYLOAD__", $payload), $utf8)
if (Test-Path $dom) { Remove-Item $dom }

$url = "file:///" + ($html -replace '\\', '/')
$edgeArgs = @(
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=$tmp\profile", "--virtual-time-budget=120000", "--dump-dom", $url
)
Start-Process -FilePath $edge -ArgumentList $edgeArgs -RedirectStandardOutput $dom -RedirectStandardError (Join-Path $tmp "edge-err.txt") -Wait -NoNewWindow

$text = if (Test-Path $dom) { [IO.File]::ReadAllText($dom, $utf8) } else { "" }
$m = [regex]::Match($text, '(?s)<pre id="out">(.*?)</pre>')
if (-not $m.Success -or $m.Groups[1].Value -eq "pending") {
  Write-Host "Edge produced no result (the page did not finish). See $tmp"
  exit 2
}
$result = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) | ConvertFrom-Json
Write-Host $result.text
if ($result.ok) { exit 0 } else { exit 1 }
