# Run each test file sequentially in separate processes
# This ensures GPU resources are fully released between test files

$testFiles = @(
    "src/sampler/scope/tests/accumulator.test.ts",
    "src/sampler/scope/tests/buffer-comparison.test.ts",
    "src/sampler/scope/tests/spectrogram.test.ts",
    "src/sampler/scope/tests/transformer.test.ts",
    "src/sampler/scope/tests/wavelet-transform.test.ts"
)

$totalPassed = 0
$totalFailed = 0
$failedFiles = @()

foreach ($file in $testFiles) {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "Running: $file" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    $output = deno test $file --allow-read --allow-write 2>&1 | Out-String
    Write-Host $output

    if ($output -match "(\d+) passed") {
        $totalPassed += [int]$matches[1]
    }
    if ($output -match "(\d+) failed") {
        $totalFailed += [int]$matches[1]
        $failedFiles += $file
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $file" -ForegroundColor Red
    } else {
        Write-Host "PASSED: $file" -ForegroundColor Green
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "FINAL RESULTS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Total Passed: $totalPassed" -ForegroundColor Green
Write-Host "Total Failed: $totalFailed" -ForegroundColor $(if ($totalFailed -eq 0) { "Green" } else { "Red" })

if ($failedFiles.Count -gt 0) {
    Write-Host "`nFailed files:" -ForegroundColor Red
    foreach ($file in $failedFiles) {
        Write-Host "  - $file" -ForegroundColor Red
    }
    exit 1
} else {
    Write-Host "`nAll tests passed!" -ForegroundColor Green
    exit 0
}
