import { readFileSync } from 'fs';
import { resolve } from 'path';
import { INITIAL_REPOSITORY_CREATION_CAPABILITIES } from '../safe/repositoryCreationCapabilities';
import { REPOSITORY_OBJECT_KINDS } from '../safe/repositoryCreationTypes';

interface CoverageManifest {
  eclipseAdtVersion: string;
  installedWizardCandidateTypes: string[];
  explicitCreationAdapterTypes: string[];
  controlledMappings: Record<string, string>;
}

function loadManifest(): CoverageManifest {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), 'docs/evidence/eclipse-adt-3.60.2-creation-wizard-manifest.json'),
    'utf8'
  )) as CoverageManifest;
}

describe('Eclipse ADT repository creation coverage manifest', () => {
  it('freezes the installed ADT 3.60.2 wizard and explicit adapter candidate sets', () => {
    const manifest = loadManifest();

    expect(manifest.eclipseAdtVersion).toBe('3.60.2');
    expect(manifest.installedWizardCandidateTypes).toHaveLength(142);
    expect(new Set(manifest.installedWizardCandidateTypes).size).toBe(142);
    expect(manifest.explicitCreationAdapterTypes).toHaveLength(28);
    expect(manifest.installedWizardCandidateTypes).toEqual([...manifest.installedWizardCandidateTypes].sort());
    expect(manifest.explicitCreationAdapterTypes).toEqual([...manifest.explicitCreationAdapterTypes].sort());
  });

  it('maps every controlled capability to exactly one installed wizard candidate', () => {
    const manifest = loadManifest();
    const mappings = Object.entries(manifest.controlledMappings);
    const capabilities = new Map(INITIAL_REPOSITORY_CREATION_CAPABILITIES.map(capability => [capability.adtType, capability]));

    expect(mappings).toHaveLength(31);
    expect(mappings.map(([, objectKind]) => objectKind).sort()).toEqual([...REPOSITORY_OBJECT_KINDS].sort());
    expect(capabilities.size).toBe(mappings.length);
    for (const [adtType, objectKind] of mappings) {
      expect(manifest.installedWizardCandidateTypes).toContain(adtType);
      expect(capabilities.get(adtType)?.objectKind).toBe(objectKind);
    }
  });

  it('keeps wizard-only creation evidence separate from explicit adapters', () => {
    const manifest = loadManifest();
    const adapterTypes = new Set(manifest.explicitCreationAdapterTypes);
    const wizardOnlyControlled = Object.keys(manifest.controlledMappings)
      .filter(adtType => !adapterTypes.has(adtType))
      .sort();

    expect(wizardOnlyControlled).toEqual(['DDLA/ADF', 'DEVC/K', 'TTYP/DA']);
    expect(manifest.explicitCreationAdapterTypes).toContain('FUGR/I');
    expect(manifest.controlledMappings).toHaveProperty('FUGR/I', 'FUNCTION_GROUP_INCLUDE');
  });
});
