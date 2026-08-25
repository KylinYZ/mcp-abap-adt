param(
  [string]$PluginsPath = $env:SAP_ADT_ECLIPSE_PLUGINS,
  [string]$ManifestPath = (Join-Path $PSScriptRoot '..\docs\evidence\eclipse-adt-3.60.2-creation-wizard-manifest.json')
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($PluginsPath)) {
  throw 'Set SAP_ADT_ECLIPSE_PLUGINS or pass -PluginsPath with the Eclipse plugins directory.'
}
$resolvedPluginsPath = (Resolve-Path -LiteralPath $PluginsPath).Path
$resolvedManifestPath = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifest = Get-Content -Raw -LiteralPath $resolvedManifestPath | ConvertFrom-Json

Add-Type -AssemblyName System.IO.Compression.FileSystem
$objectTypes = @{}
$uiMappings = @()
$wizards = @{}

# A visible ABAP New Wizard is the broad creation candidate signal; creationAdapter is optional protocol evidence.
foreach ($jarPath in Get-ChildItem -LiteralPath $resolvedPluginsPath -Filter '*.jar') {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($jarPath.FullName)
  try {
    $entry = $archive.GetEntry('plugin.xml')
    if ($null -eq $entry) { continue }
    $reader = [System.IO.StreamReader]::new($entry.Open())
    try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
    try { [xml]$xml = $content } catch { continue }

    foreach ($extension in $xml.plugin.extension) {
      switch ([string]$extension.point) {
        'com.sap.adt.tools.core.objectTypes' {
          foreach ($info in $extension.objectTypeInfo) {
            $id = [string]$info.id
            if ([string]::IsNullOrWhiteSpace($id)) { continue }
            $objectTypes[$id] = [pscustomobject]@{
              AdtType = [string]$info.globalWorkbenchType
              CreationAdapter = if ($info.creationAdapter) { [string]$info.creationAdapter.class } else { '' }
            }
          }
        }
        'com.sap.adt.tools.core.ui.objectTypes' {
          foreach ($ui in $extension.objectTypeInfoUI) {
            $uiMappings += [pscustomobject]@{
              WizardId = [string]$ui.newWizardId
              ObjectTypeInfoId = [string]$ui.objectTypeInfo
            }
          }
        }
        'org.eclipse.ui.newWizards' {
          foreach ($wizard in $extension.wizard) {
            $id = [string]$wizard.id
            if (-not [string]::IsNullOrWhiteSpace($id)) { $wizards[$id] = [string]$wizard.category }
          }
        }
      }
    }
  } finally {
    $archive.Dispose()
  }
}

$linkedObjectTypes = foreach ($mapping in $uiMappings) {
  if ([string]::IsNullOrWhiteSpace($mapping.WizardId)) { continue }
  if (-not $wizards.ContainsKey($mapping.WizardId)) { continue }
  if (-not $objectTypes.ContainsKey($mapping.ObjectTypeInfoId)) { continue }
  if ($wizards[$mapping.WizardId] -notmatch '^com\.sap\.adt') { continue }
  $objectTypes[$mapping.ObjectTypeInfoId]
}

$actualWizardTypes = @($linkedObjectTypes.AdtType | Sort-Object -Unique)
$actualAdapterTypes = @($linkedObjectTypes | Where-Object CreationAdapter | ForEach-Object AdtType | Sort-Object -Unique)
$expectedWizardTypes = @($manifest.installedWizardCandidateTypes | Sort-Object -Unique)
$expectedAdapterTypes = @($manifest.explicitCreationAdapterTypes | Sort-Object -Unique)

$wizardDiff = Compare-Object $expectedWizardTypes $actualWizardTypes
$adapterDiff = Compare-Object $expectedAdapterTypes $actualAdapterTypes
if ($wizardDiff -or $adapterDiff) {
  if ($wizardDiff) { Write-Host 'Wizard candidate drift:'; $wizardDiff | Format-Table -AutoSize }
  if ($adapterDiff) { Write-Host 'Creation adapter drift:'; $adapterDiff | Format-Table -AutoSize }
  throw 'Eclipse ADT creation evidence differs from the checked-in manifest.'
}

Write-Host "Eclipse ADT $($manifest.eclipseAdtVersion) wizard candidates verified: $($actualWizardTypes.Count)"
Write-Host "Explicit creationAdapter types verified: $($actualAdapterTypes.Count)"
