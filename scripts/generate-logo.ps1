# Generates a monochrome BMP suitable for the H80i / POS80 Watermark feature.
#
# Usage (from PowerShell, in the project root):
#   .\scripts\generate-logo.ps1
#   .\scripts\generate-logo.ps1 -Text "Girr Kathiyawadi"
#   .\scripts\generate-logo.ps1 -Text "Girr Kathiyawadi" -FontSize 28 -Height 70
#
# Output: restaurant-logo.bmp in the project root.

param(
    [string]$Text     = 'Girr Kathiyawadi',
    [int]   $Width    = 576,    # 80mm @ 203 DPI = 576 dots wide
    [int]   $Height   = 60,
    [int]   $FontSize = 24,
    [string]$Font     = 'Arial',
    [string]$Output   = 'restaurant-logo.bmp'
)

Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap $Width, $Height
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

$fontObj = New-Object System.Drawing.Font $Font, $FontSize, ([System.Drawing.FontStyle]::Bold)
$brush   = [System.Drawing.Brushes]::Black

$size = $g.MeasureString($Text, $fontObj)
$x    = ($Width  - $size.Width)  / 2
$y    = ($Height - $size.Height) / 2
$g.DrawString($Text, $fontObj, $brush, $x, $y)

$g.Dispose()
$fontObj.Dispose()

# Convert to 1bpp monochrome — required for thermal printers.
$rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
$mono = $bmp.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format1bppIndexed)
$mono.Save($Output, [System.Drawing.Imaging.ImageFormat]::Bmp)

$mono.Dispose()
$bmp.Dispose()

$absPath = (Resolve-Path $Output).Path
Write-Host "Saved $absPath  ($Width x $Height, 1-bit monochrome)"
