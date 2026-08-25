import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const manifestPath = resolve(repositoryRoot, 'docs/evidence/eclipse-adt-3.60.2-creation-wizard-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const { INITIAL_REPOSITORY_CREATION_CAPABILITIES } = require(resolve(repositoryRoot, 'dist/safe/repositoryCreationCapabilities.js'));
const { REPOSITORY_OBJECT_KINDS } = require(resolve(repositoryRoot, 'dist/safe/repositoryCreationTypes.js'));

// The JAR snapshot is the product target; the runtime registry is the implemented subset.
assertSortedUnique(manifest.installedWizardCandidateTypes, 'installedWizardCandidateTypes');
assertSortedUnique(manifest.explicitCreationAdapterTypes, 'explicitCreationAdapterTypes');
assertEqual(manifest.installedWizardCandidateTypes.length, 142, 'Unexpected ADT wizard candidate count.');
assertEqual(manifest.explicitCreationAdapterTypes.length, 28, 'Unexpected explicit creation adapter count.');

const candidateTypes = new Set(manifest.installedWizardCandidateTypes);
const adapterTypes = new Set(manifest.explicitCreationAdapterTypes);
for (const adtType of adapterTypes) assert(candidateTypes.has(adtType), `Creation adapter type ${adtType} has no wizard candidate.`);

const controlledEntries = Object.entries(manifest.controlledMappings);
const controlledKinds = controlledEntries.map(([, objectKind]) => objectKind).sort();
assertSortedUnique(controlledKinds, 'controlledMappings values');
assertEqual(controlledEntries.length, 31, 'Unexpected controlled mapping count.');
assertDeepEqual(controlledKinds, [...REPOSITORY_OBJECT_KINDS].sort(), 'Manifest kinds differ from REPOSITORY_OBJECT_KINDS.');

const capabilitiesByAdtType = new Map(
  INITIAL_REPOSITORY_CREATION_CAPABILITIES.map(capability => [capability.adtType, capability])
);
assertEqual(capabilitiesByAdtType.size, INITIAL_REPOSITORY_CREATION_CAPABILITIES.length, 'Capability ADT types are not unique.');
for (const [adtType, objectKind] of controlledEntries) {
  assert(candidateTypes.has(adtType), `Controlled ADT type ${adtType} is absent from the Eclipse wizard snapshot.`);
  const capability = capabilitiesByAdtType.get(adtType);
  assert(capability, `Controlled ADT type ${adtType} has no capability definition.`);
  assertEqual(capability.objectKind, objectKind, `Controlled mapping mismatch for ${adtType}.`);
}
assertEqual(capabilitiesByAdtType.size, controlledEntries.length, 'A capability exists outside the controlled manifest mapping.');

const controlledWithExplicitAdapter = controlledEntries.filter(([adtType]) => adapterTypes.has(adtType));
const wizardOnlyControlled = controlledEntries.filter(([adtType]) => !adapterTypes.has(adtType)).map(([adtType]) => adtType).sort();
assertDeepEqual(wizardOnlyControlled, ['DDLA/ADF', 'DEVC/K', 'TTYP/DA'], 'Wizard-only controlled evidence changed.');

const realDevVerified = INITIAL_REPOSITORY_CREATION_CAPABILITIES
  .filter(capability => capability.maturity === 'REAL_DEV_VERIFIED')
  .map(capability => capability.adtType)
  .sort();
const pendingTypes = manifest.installedWizardCandidateTypes.filter(adtType => !(adtType in manifest.controlledMappings));

console.log(`Eclipse ADT ${manifest.eclipseAdtVersion} installed wizard candidates: ${candidateTypes.size}`);
console.log(`Explicit creationAdapter types: ${adapterTypes.size}`);
console.log(`Controlled MCP types: ${controlledEntries.length} (${controlledWithExplicitAdapter.length} adapter-backed, ${wizardOnlyControlled.length} wizard-backed)`);
console.log(`Pending wizard candidates: ${pendingTypes.length}`);
console.log(`REAL_DEV_VERIFIED controlled types: ${realDevVerified.length}`);

function assertSortedUnique(values, label) {
  assert(Array.isArray(values), `${label} must be an array.`);
  assertDeepEqual(values, [...new Set(values)].sort(), `${label} must be sorted and unique.`);
}

function assertDeepEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} actual=${actual} expected=${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
