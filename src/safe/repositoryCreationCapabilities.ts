import type {
  RepositoryCreationCapabilityDefinition,
  RepositoryCreationEvidenceSource,
  RepositoryObjectKind
} from './repositoryCreationTypes.js';

const commonObjectProperties = {
  name: { type: 'string', description: 'Repository object name', minLength: 1, maxLength: 128 },
  description: { type: 'string', description: 'Short language-dependent description', minLength: 1, maxLength: 120 },
  transportRequest: { type: 'string', description: 'Existing unreleased ten-character transport request', minLength: 10, maxLength: 10 }
};

const REAL_DEV_SOURCE_OBJECTS = new Set<RepositoryObjectKind>([
  'ABAP_INTERFACE',
  'PROGRAM_INCLUDE',
  'CDS_DATA_DEFINITION',
  'CDS_ACCESS_CONTROL',
  'CDS_METADATA_EXTENSION',
  'SERVICE_DEFINITION',
  'BEHAVIOR_DEFINITION',
  'CDS_TYPE',
  'CDS_ASPECT'
]);

// This matrix records platform maturity, not merely the existence of an ADT endpoint.
export const INITIAL_REPOSITORY_CREATION_CAPABILITIES: RepositoryCreationCapabilityDefinition[] = [
  {
    objectKind: 'MESSAGE_CLASS', adtType: 'MSAG/N', displayName: 'Message Class', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'VSCODE_ABAP_REMOTE_FS', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one message class and optionally initialize bounded three-digit short messages.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        messages: {
          type: 'array', minItems: 0, maxItems: 100, optional: true,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              number: { type: 'string', description: 'Three-digit message number from 001 to 999', minLength: 3, maxLength: 3 },
              text: { type: 'string', description: 'Short message text; long texts remain a separate SAP operation', minLength: 1, maxLength: 72 }
            },
            required: ['number', 'text']
          }
        }
      },
      required: ['name', 'description', 'packageName', 'transportRequest']
    },
    fixedDefaults: { objectType: 'MSAG/N', creationContentType: 'application/*', messageTextLimit: 72 },
    validationRules: ['The message class name must be a valid repository name of at most 20 characters.', 'Message numbers are unique three-digit values 001-999.', 'Only short message text is supported; long-text editing remains outside this creation capability.', 'Source, lock, activation, and active message verification are tied to the confirmed plan.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'],
    compensationLimits: ['Only the message class proven to have been created by the current plan may be deleted.', 'Unknown source, unlock, activation, or verification outcomes stop automatic compensation.']
  },
  {
    objectKind: 'DDIC_DOMAIN', adtType: 'DOMA/DD', displayName: 'DDIC Domain', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2', 'REAL_DEV_EXECUTION'],
    requirements: { source: false, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one DDIC domain shell and apply its typed domain properties in an existing transportable package.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        properties: {
          type: 'object', additionalProperties: false,
          properties: {
            typeInformation: { type: 'object', additionalProperties: false, properties: { datatype: { type: 'string', minLength: 1, maxLength: 30 }, length: { type: 'number', minimum: 1, maximum: 5000 }, decimals: { type: 'number', minimum: 0, maximum: 31 } }, required: ['datatype', 'length', 'decimals'] },
            outputInformation: { type: 'object', additionalProperties: false, properties: { length: { type: 'number', minimum: 1, maximum: 5000 }, style: { type: 'string', maxLength: 30, optional: true }, conversionExit: { type: 'string', maxLength: 5, optional: true }, signExists: { type: 'boolean' }, lowercase: { type: 'boolean' }, ampmFormat: { type: 'boolean' } }, required: ['length', 'signExists', 'lowercase', 'ampmFormat'] },
            valueInformation: { type: 'object', additionalProperties: false, optional: true, properties: { valueTableRef: { type: 'string', maxLength: 30, optional: true }, appendExists: { type: 'boolean' }, fixValues: { type: 'array', maxItems: 100, optional: true } }, required: ['appendExists'] }
          },
          required: ['typeInformation', 'outputInformation']
        }
      },
      required: ['name', 'description', 'packageName', 'transportRequest', 'properties']
    },
    fixedDefaults: { objectType: 'DOMA/DD', creationContentType: 'application/*' },
    validationRules: ['The package must exist and be transportable.', 'Typed domain and output properties are bounded and sent through the DDIC domain property contract.', 'The shell, property write, activation, and active-state readback are all tied to this plan.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_PROPERTIES', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_PROPERTIES'],
    compensationLimits: ['Only the domain proven to have been created by the current plan may be deleted.', 'Unknown property, unlock, activation, or verification outcomes stop automatic compensation.']
  },
  {
    objectKind: 'DATA_ELEMENT', adtType: 'DTEL/DE', displayName: 'DDIC Data Element', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2', 'REAL_DEV_EXECUTION'],
    requirements: { source: false, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one DDIC data element shell and apply its typed labels and type properties in an existing transportable package.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        properties: {
          type: 'object', additionalProperties: false,
          properties: {
            typeName: { type: 'string', description: 'Existing domain name, or empty for a predefined ABAP type', maxLength: 30, optional: true },
            dataType: { type: 'string', minLength: 1, maxLength: 30 },
            dataTypeLength: { type: 'number', minimum: 1, maximum: 5000 },
            dataTypeDecimals: { type: 'number', minimum: 0, maximum: 31, optional: true },
            fieldLabels: { type: 'object', additionalProperties: false, properties: { shortFieldLabel: { type: 'string', minLength: 1, maxLength: 10 }, mediumFieldLabel: { type: 'string', minLength: 1, maxLength: 20 }, longFieldLabel: { type: 'string', minLength: 1, maxLength: 40 }, headingFieldLabel: { type: 'string', minLength: 1, maxLength: 55 } }, required: ['shortFieldLabel', 'mediumFieldLabel', 'longFieldLabel', 'headingFieldLabel'] },
            searchHelp: { type: 'string', maxLength: 30, optional: true },
            searchHelpParameter: { type: 'string', maxLength: 30, optional: true },
            setGetParameter: { type: 'string', maxLength: 20, optional: true },
            defaultComponentName: { type: 'string', maxLength: 30, optional: true },
            deactivateInputHistory: { type: 'boolean', optional: true },
            changeDocument: { type: 'boolean', optional: true },
            leftToRightDirection: { type: 'boolean', optional: true },
            deactivateBIDIFiltering: { type: 'boolean', optional: true }
          },
          required: ['dataType', 'dataTypeLength', 'fieldLabels']
        }
      },
      required: ['name', 'description', 'packageName', 'transportRequest', 'properties']
    },
    fixedDefaults: { objectType: 'DTEL/DE', creationContentType: 'application/*' },
    validationRules: ['The package must exist and be transportable.', 'Field labels and type properties are bounded; an optional typeName is a repository domain reference.', 'The shell, property write, activation, and active-state readback are all tied to this plan.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_PROPERTIES', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_PROPERTIES'],
    compensationLimits: ['Only the data element proven to have been created by the current plan may be deleted.', 'Unknown property, unlock, activation, or verification outcomes stop automatic compensation.']
  },
  {
    objectKind: 'PROGRAM', adtType: 'PROG/P', displayName: 'ABAP Program', family: 'ABAP_SOURCE', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['CURRENT_CONTROLLED_WORKFLOW', 'ECLIPSE_ADT_3_60_2', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one complete ABAP program in an existing transportable package.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        source: { type: 'string', description: 'Complete REPORT or PROGRAM source', minLength: 1 }
      },
      required: ['name', 'description', 'packageName', 'transportRequest', 'source']
    },
    fixedDefaults: {},
    validationRules: ['The name must be inside the configured namespace allow-list.', 'The target must not already exist.', 'The source must declare the requested program name.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'],
    compensationLimits: ['Only an object proven to have been created by the current plan may be deleted.']
  },
  {
    objectKind: 'FUNCTION_GROUP', adtType: 'FUGR/F', displayName: 'Function Group', family: 'ABAP_FUNCTION', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['CURRENT_CONTROLLED_WORKFLOW', 'ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG', 'REAL_DEV_EXECUTION'],
    requirements: { source: false, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create a function group together with its first function module; SAP owns the generated function-pool includes.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        initialFunctionModule: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 30 },
            description: { type: 'string', minLength: 1, maxLength: 120 },
            source: { type: 'string', description: 'Complete FUNCTION ... ENDFUNCTION source', minLength: 1 }
          },
          required: ['name', 'description', 'source']
        }
      },
      required: ['name', 'description', 'packageName', 'transportRequest', 'initialFunctionModule']
    },
    fixedDefaults: { generatedIncludesOwnedBySap: true },
    validationRules: ['Standalone empty function-group creation remains disabled.', 'The first function module must reference the new group.', 'Generated group includes cannot be supplied or overwritten.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'CREATE_SHELL', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'],
    compensationLimits: ['The new function module is removed before its owning new function group.', 'Unknown activation outcomes stop compensation.']
  },
  {
    objectKind: 'FUNCTION_MODULE', adtType: 'FUGR/FF', displayName: 'Function Module', family: 'ABAP_FUNCTION', parentKind: 'FUNCTION_GROUP',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['CURRENT_CONTROLLED_WORKFLOW', 'ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one complete function module in an existing function group.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        parentFunctionGroup: { type: 'string', description: 'Existing function group', minLength: 1, maxLength: 26 },
        source: { type: 'string', description: 'Complete FUNCTION ... ENDFUNCTION source', minLength: 1 }
      },
      required: ['name', 'description', 'parentFunctionGroup', 'transportRequest', 'source']
    },
    fixedDefaults: {},
    validationRules: ['The parent function group must already exist.', 'The source must declare the requested function module name.', 'Only the verified signature separator formatting difference is tolerated.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'],
    compensationLimits: ['Only the newly created function module is eligible for automatic deletion.', 'Unknown activation outcomes stop compensation.']
  },
  {
    objectKind: 'FUNCTION_GROUP_INCLUDE', adtType: 'FUGR/I', displayName: 'Function Group Include', family: 'ABAP_FUNCTION', parentKind: 'FUNCTION_GROUP',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['CURRENT_CONTROLLED_WORKFLOW', 'ECLIPSE_ADT_3_60_2', 'VSCODE_ABAP_REMOTE_FS', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one function-group include from a strict three-character suffix and complete ABAP source.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Three-character include suffix; SAP uses the full L... include name for validation and creation', minLength: 3, maxLength: 3 },
        description: { type: 'string', description: 'Short language-dependent description', minLength: 1, maxLength: 120 },
        parentFunctionGroup: { type: 'string', description: 'Existing function group', minLength: 1, maxLength: 26 },
        transportRequest: { type: 'string', description: 'Existing unreleased ten-character transport request', minLength: 10, maxLength: 10 },
        source: { type: 'string', description: 'Complete include source, normally FUNCTION-POOL or include declarations', minLength: 1 }
      },
      required: ['name', 'description', 'parentFunctionGroup', 'transportRequest', 'source']
    },
    fixedDefaults: { generatedNamePrefix: 'L<FUNCTION_GROUP>', creationContentType: 'application/vnd.sap.adt.functions.fincludes.v2+xml' },
    validationRules: ['The suffix must be exactly three repository-name characters.', 'The parent function group must already exist.', 'The derived full include name must not already exist.', 'The full include name is sent to ADT validation and creation; source verification reads the include working area.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'VALIDATE_PARENT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'],
    compensationLimits: ['Only the include proven to have been created by the current plan may be deleted.', 'Unknown create, source, activation, or verification outcomes stop compensation.']
  },
  {
    objectKind: 'PACKAGE', adtType: 'DEVC/K', displayName: 'Development Package', family: 'PACKAGE', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG', 'ABAP_ADT_API_8_4_2', 'REAL_DEV_EXECUTION'],
    requirements: { source: false, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: false },
    summary: 'Create one encapsulated development subpackage with record-changes enabled.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        parentPackageName: { type: 'string', description: 'Existing transportable superpackage', minLength: 1, maxLength: 30 },
        softwareComponent: { type: 'string', description: 'Software component accepted by target constraints', minLength: 1, maxLength: 30 },
        transportLayer: { type: 'string', description: 'Transport layer accepted by target constraints', minLength: 1, maxLength: 20 }
      },
      required: ['name', 'description', 'parentPackageName', 'softwareComponent', 'transportLayer', 'transportRequest']
    },
    fixedDefaults: { packageType: 'development', isEncapsulated: true, recordChanges: true },
    validationRules: ['The parent package and target constraints must be read before creation.', 'Main and structure packages are not accepted.', 'The target package must not already exist.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_PROPERTIES'],
    compensationLimits: ['A new package may be deleted only when ownership is proven and the package is empty.']
  },
  {
    objectKind: 'DATABASE_TABLE', adtType: 'TABL/DT', displayName: 'Database Table', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG', 'ABAP_ADT_API_8_4_2', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: true, transportRequest: true, separateActivation: true },
    summary: 'Create one transparent database table from structured fields and controlled technical settings.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        fields: {
          type: 'array', minItems: 1, maxItems: 500,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 30 },
              key: { type: 'boolean', optional: true },
              type: { type: 'string', description: 'Allowed ABAP built-in type or data element', minLength: 1, maxLength: 128 },
              length: { type: 'number', minimum: 1, maximum: 5000, optional: true },
              decimals: { type: 'number', minimum: 0, maximum: 31, optional: true },
              notNull: { type: 'boolean', optional: true },
              description: { type: 'string', maxLength: 120, optional: true },
              referenceField: { type: 'string', description: 'Required for CURR and QUAN fields', maxLength: 30, optional: true }
            },
            required: ['name', 'type']
          }
        },
        technicalSettings: {
          type: 'object', additionalProperties: false, optional: true,
          properties: {
            dataClass: { type: 'string', enum: ['APPL0', 'APPL1', 'APPL2', 'APPL3', 'USER'] },
            sizeCategory: { type: 'number', minimum: 0, maximum: 9 },
            buffering: { type: 'string', enum: ['NOT_ALLOWED'] },
            loggingEnabled: { type: 'boolean' }
          }
        }
      },
      required: ['name', 'description', 'packageName', 'transportRequest', 'fields']
    },
    fixedDefaults: { tableCategory: 'TRANSPARENT', enhancementCategory: 'NOT_EXTENSIBLE', deliveryClass: 'A', dataMaintenance: 'RESTRICTED', buffering: 'NOT_ALLOWED', loggingEnabled: false },
    validationRules: ['Arbitrary annotations are forbidden.', 'CURR requires a structured currency reference field.', 'QUAN requires a structured unit-of-measure reference field.', 'Table source and technical settings are checked, activated, and verified separately.'],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'LOCK_RESOURCE', 'RUN_CHECKS', 'WRITE_SOURCE', 'VERIFY_SOURCE', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'LOCK_RESOURCE', 'WRITE_TECHNICAL_SETTINGS', 'UNLOCK_RESOURCE', 'ACTIVATE_RESOURCE', 'VERIFY_TECHNICAL_SETTINGS'],
    compensationLimits: ['Only a table proven to have been created by the current plan may be deleted.', 'Unknown source, activation, or settings outcomes stop compensation.']
  },
  {
    objectKind: 'DDIC_TABLE_TYPE', adtType: 'TTYP/DA', displayName: 'DDIC Table Type', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG', 'TARGET_ADT_DISCOVERY', 'REAL_DEV_EXECUTION'],
    requirements: { source: false, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one structured DDIC table type with a server-advertised ABAP row type and bounded key settings.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        rowType: {
          type: 'object', additionalProperties: false,
          properties: {
            typeKind: { type: 'string', enum: ['predefinedAbapType', 'dictionaryType', 'referenceToPredefinedType', 'referenceToDictionaryType', 'referenceToClassInterface', 'rangeTableOnPredefinedType', 'rangeTableOnDataElement'] },
            typeName: { type: 'string', description: 'Existing DDIC/class/interface type when required by typeKind', minLength: 1, maxLength: 30, optional: true },
            dataType: { type: 'string', description: 'Type advertised by the target /ddic/codecompletion abapType endpoint', minLength: 1, maxLength: 30, optional: true },
            length: { type: 'number', minimum: 0, maximum: 32000, optional: true },
            decimals: { type: 'number', minimum: 0, maximum: 31, optional: true },
            rangeType: { type: 'string', maxLength: 30, optional: true }
          },
          required: ['typeKind']
        },
        initialRowCount: { type: 'number', minimum: 0, maximum: 99999, optional: true },
        accessType: { type: 'string', enum: ['standard', 'sorted', 'hashed', 'index'], optional: true },
        primaryKey: {
          type: 'object', additionalProperties: false, optional: true,
          properties: {
            definition: { type: 'string', enum: ['standard', 'rowType', 'keyComponents', 'empty'], optional: true },
            kind: { type: 'string', enum: ['unique', 'nonUnique'], optional: true }
          }
        },
        secondaryKeys: {
          type: 'object', additionalProperties: false, optional: true,
          properties: { allowed: { type: 'string', enum: ['allowed', 'notAllowed', 'notSpecified'], optional: true } }
        }
      },
      required: ['name', 'description', 'packageName', 'transportRequest', 'rowType']
    },
    fixedDefaults: { objectType: 'TTYP/DA', contentType: 'application/vnd.sap.adt.tabletype.v1+xml', initialRowCount: 0, accessType: 'standard', primaryKeyDefinition: 'standard', primaryKeyKind: 'nonUnique', secondaryKeysAllowed: 'notSpecified' },
    validationRules: [
      'The table type name is limited to thirty characters and the description follows the target sixty-character property limit.',
      'Predefined row types must be advertised by the target /sap/bc/adt/ddic/codecompletion?type=abapType response; length and decimals use the returned min/max rules, including CURR and QUAN.',
      'The table type is a structured XML object; callers cannot provide XML, URLs, media types, links, or lock handles.',
      'Primary-key components and secondary-key definitions beyond the captured ADT contract remain disabled until their exact request shape is captured.',
      'The shell, property write, working-area read, unlock, activation, and active read are all tied to the confirmed plan.'
    ],
    executionStages: ['REVALIDATE_ABSENCE', 'REVALIDATE_ABAP_TYPES', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_PROPERTIES', 'VERIFY_PROPERTIES', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_PROPERTIES'],
    compensationLimits: ['Only the table type proven to have been created by the current plan may be deleted.', 'Unknown shell, property, unlock, activation, or verification outcomes stop automatic compensation.']
  },
  {
    objectKind: 'DDIC_STRUCTURE', adtType: 'TABL/DS', displayName: 'DDIC Structure', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'CONTROLLED_IMPLEMENTED', targetAvailable: true,
    evidenceSources: ['CURRENT_CONTROLLED_WORKFLOW', 'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one DDIC structure from controlled component fields in an existing transportable package.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        fields: {
          type: 'array', minItems: 1, maxItems: 500,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 30 },
              type: { type: 'string', description: 'Allowed ABAP built-in type or data element', minLength: 1, maxLength: 128 },
              length: { type: 'number', minimum: 1, maximum: 5000, optional: true },
              decimals: { type: 'number', minimum: 0, maximum: 31, optional: true },
              description: { type: 'string', maxLength: 120, optional: true }
            },
            required: ['name', 'type']
          }
        }
      },
      required: ['name', 'description', 'packageName', 'transportRequest', 'fields']
    },
    fixedDefaults: { structureType: 'TABL/DS', creationContentType: 'ADT_DISCOVERY' },
    validationRules: [
      'The target structure must not already exist.',
      'The ADT discovery document must expose an accepted creation content type.',
      'Structure components cannot be keys or use unbound CURR/QUAN references in this slice.',
      'Source is locked, checked, activated, and read back after creation.'
    ],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'PREWRITE_CHECKS', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'],
    compensationLimits: ['Only the structure proven to have been created by the current plan may be deleted.', 'Unknown shell, source, unlock, or activation outcomes stop automatic compensation.']
  },
  {
    objectKind: 'DDIC_TYPE_GROUP', adtType: 'TYPE/DG', displayName: 'DDIC Type Group', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one ABAP type group with a complete TYPE-POOL source in an existing transportable package.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        name: { type: 'string', description: 'Five-character DDIC type group name', minLength: 1, maxLength: 5 },
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        source: { type: 'string', description: 'Complete TYPE-POOL source', minLength: 1 }
      },
      required: ['name', 'description', 'packageName', 'transportRequest', 'source']
    },
    fixedDefaults: { objectType: 'TYPE/DG', creationContentType: 'ADT_DISCOVERY' },
    validationRules: [
      'The type group name is limited to five characters by the target DDIC protocol.',
      'The target must not already exist and the package must be transportable.',
      'The source must declare the requested TYPE-POOL name.',
      'The discovered creation media type is frozen between preview and apply; source is checked, activated, and read back.'
    ],
    executionStages: ['REVALIDATE_ABSENCE', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'],
    compensationLimits: ['Only the type group proven to have been created by the current plan may be deleted.', 'Unknown shell, source, unlock, or activation outcomes stop automatic compensation.']
  },
  {
    objectKind: 'DDIC_LOCK_OBJECT', adtType: 'ENQU/DL', displayName: 'DDIC Lock Object', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'CONTROLLED_IMPLEMENTED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG'],
    requirements: { source: false, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: false },
    summary: 'Create one structured DDIC lock object for an existing primary database table.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        primaryTable: { type: 'string', description: 'Existing primary database table', minLength: 1, maxLength: 30 }
      },
      required: ['name', 'description', 'packageName', 'primaryTable', 'transportRequest']
    },
    fixedDefaults: { objectType: 'ENQU/DL', allowRFC: false, lockMode: '' },
    validationRules: [
      'The lock object name is limited to sixteen characters by the target DDIC protocol.',
      'The package and primary table must exist and the package must be transportable.',
      'The structured XML attributes are fixed by the Eclipse adapter; callers cannot supply secondary tables, parameters, modules, XML, or headers.',
      'Creation is verified by the canonical response and a follow-up object read; no source or separate activation flow is assumed.'
    ],
    executionStages: ['REVALIDATE_ABSENCE', 'REVALIDATE_REFERENCE', 'VALIDATE_TRANSPORT', 'CREATE_OBJECT', 'VERIFY_CREATED_OBJECT'],
    compensationLimits: ['Only the lock object proven to have been created by the current plan may be deleted.', 'Unknown create, delete, or lock outcomes stop automatic compensation.']
  },
  {
    objectKind: 'LOGICAL_EXTERNAL_SCHEMA', adtType: 'DESD/TYP', displayName: 'Logical External Schema', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one Logical External Schema using the ADT server-driven objectTypes.v1 contract.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        defaultRemoteSchemaName: { type: 'string', description: 'Default remote schema name', minLength: 1, maxLength: 255 },
        abapLanguageVersion: { type: 'string', enum: ['standard', 'cloudDevelopment'], optional: true }
      },
      required: ['name', 'description', 'packageName', 'defaultRemoteSchemaName', 'transportRequest']
    },
    fixedDefaults: { objectType: 'DESD/TYP', shellContentType: 'application/vnd.sap.adt.blues.v1+xml', contentType: 'application/json', formatVersion: '1', usesRouting: false },
    validationRules: [
      'The target must not already exist and the package must be transportable.',
      'The ADT $schema document is read and frozen during preview and revalidated during apply.',
      'The source link must remain inside the DESD collection and use the reviewed objectTypes.v1 JSON contract.',
      'usesRouting is SAP-owned and cannot be requested; a true value is rejected on read-back.',
      'The shell, JSON content, activation, and active metadata/content are verified separately.'
    ],
    executionStages: ['REVALIDATE_ABSENCE', 'REVALIDATE_SCHEMA', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_CONTENT', 'VERIFY_CONTENT', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_CONTENT'],
    compensationLimits: ['Only the Logical External Schema proven to have been created by the current plan may be deleted.', 'Unknown shell, JSON content, unlock, or activation outcomes stop automatic compensation.']
  },
  {
    objectKind: 'NUMBER_RANGE_OBJECT', adtType: 'NROB/NRO', displayName: 'Number Range Object', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'TARGET_ADT_DISCOVERY', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one Number Range Object using the ADT server-driven objectTypes.v1 contract and verified DDIC references.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        name: { type: 'string', description: 'Number Range Object name', minLength: 1, maxLength: 10 },
        description: { type: 'string', description: 'Number Range Object description', minLength: 1, maxLength: 60 },
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        numberLengthDomain: { type: 'string', description: 'Active CHAR or NUMC domain with length 1-20', minLength: 1, maxLength: 30 },
        percentWarning: { type: 'number', minimum: 0.1, maximum: 99.9 },
        subType: { type: 'string', description: 'Optional active Data Element whose domain has a check table and length 1-6', minLength: 1, maxLength: 30, optional: true },
        untilYear: { type: 'boolean', description: 'Differentiate intervals by financial year' },
        rolling: { type: 'boolean', description: 'Restart assignment after an interval is exhausted' },
        prefix: { type: 'boolean', description: 'Prefix assigned numbers with the subobject name' },
        transactionId: { type: 'string', description: 'Optional active application transaction', minLength: 1, maxLength: 20, optional: true },
        buffering: { type: 'string', enum: ['mainBuffer', 'parallel', 'none'] },
        bufferedNumbers: { type: 'number', minimum: 0, maximum: 99999999 },
        abapLanguageVersion: { type: 'string', enum: ['standard', 'cloudDevelopment'], optional: true }
      },
      required: [
        'name', 'description', 'packageName', 'numberLengthDomain', 'percentWarning',
        'untilYear', 'rolling', 'prefix', 'buffering', 'bufferedNumbers', 'transportRequest'
      ]
    },
    fixedDefaults: {
      objectType: 'NROB/NRO', shellContentType: 'application/vnd.sap.adt.blues.v1+xml',
      contentType: 'application/json', schemaFramework: 'objectTypes.v1', formatVersion: '1',
      abapLanguageVersion: 'standard', bufferingSchemaDefault: 'mainBuffer', bufferedNumbersSchemaDefault: 10
    },
    validationRules: [
      'The target must not already exist and the package must be transportable.',
      'The ADT $schema document and Blue v1 shell media type are frozen during preview and revalidated during apply.',
      'numberLengthDomain must remain an active CHAR or NUMC domain with length 1-20.',
      'subType, when supplied, must remain an active Data Element backed by a 1-6 character domain with a check table; prefix=true requires subType.',
      'transactionId, when supplied, must remain an active TRAN/T object.',
      'All interval and buffering choices are explicit in the confirmed plan; callers cannot supply JSON, URLs, media types, or lock handles.',
      'The shell, JSON content, activation, and active metadata/content are verified separately.'
    ],
    executionStages: ['REVALIDATE_ABSENCE', 'REVALIDATE_SCHEMA', 'REVALIDATE_REFERENCES', 'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_CONTENT', 'VERIFY_CONTENT', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_CONTENT'],
    compensationLimits: ['Only the Number Range Object proven to have been created by the current plan may be deleted.', 'Unknown shell, JSON content, unlock, or activation outcomes stop automatic compensation.']
  },
  {
    objectKind: 'SAP_OBJECT_TYPE', adtType: 'RONT/ROT', displayName: 'SAP Object Type', family: 'RAP_METADATA', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'TARGET_ADT_DISCOVERY', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one SAP Object Type through the ADT newObjectTypes.v1 contract and a Blue v2 embedded creation payload.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        name: { type: 'string', description: 'PascalCase SAP Object Type semantic name', minLength: 1, maxLength: 30 },
        description: { type: 'string', description: 'SAP Object Type description', minLength: 1, maxLength: 60 },
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        typeCategory: {
          type: 'string',
          enum: ['businessObject', 'technicalObject', 'analyticalObject', 'configurationObject', 'dependentObject', 'hierarchyObject']
        }
      },
      required: ['name', 'description', 'packageName', 'typeCategory', 'transportRequest']
    },
    fixedDefaults: {
      objectType: 'RONT/ROT', shellContentType: 'application/vnd.sap.adt.blues.v2+xml',
      additionalContentType: 'application/vnd.sap.adt.serverdriven.content.v1+json',
      creationFramework: 'newObjectTypes.v1', sourceContentType: 'application/json', formatVersion: '1',
      repositoryNameDerivedAs: 'UPPERCASE', metadataDerivedFromRequest: true, objectTypeCodeAssignedBySap: true
    },
    validationRules: [
      'The semantic name must be a 1-30 character PascalCase identifier; the repository identity is its uppercase form.',
      'The target must not already exist and the package must remain transportable.',
      'Blue v2 discovery plus $new schema, configuration, and initial content are frozen during preview and revalidated during apply.',
      'The six reviewed category names are mapped to the Eclipse creation codes bo, to, ao, co, do, and ho.',
      'Metadata, base64 payloads, XML, URLs, media types, and the SAP-assigned objectTypeCode cannot be supplied by callers.',
      'Inactive and active metadata/content must preserve the semantic name, category, language, description, and generated objectTypeCode.'
    ],
    executionStages: [
      'REVALIDATE_ABSENCE', 'REVALIDATE_CONTRACT', 'VALIDATE_TRANSPORT', 'CREATE_OBJECT',
      'VERIFY_INACTIVE_OBJECT', 'VERIFY_INACTIVE_CONTENT', 'ACTIVATE_OBJECT',
      'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_CONTENT'
    ],
    compensationLimits: [
      'Only the SAP Object Type proven to have been created by the current plan may be deleted.',
      'Unknown Blue shell, activation, or delete outcomes stop automatic retry and compensation.'
    ]
  },
  {
    objectKind: 'SAP_OBJECT_NODE_TYPE', adtType: 'NONT/NOT', displayName: 'SAP Object Node Type', family: 'RAP_METADATA', parentKind: 'SAP_OBJECT_TYPE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'TARGET_ADT_DISCOVERY', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one SAP Object Node Type for an existing active SAP Object Type through the ADT newObjectTypes.v1 contract.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        name: { type: 'string', description: 'PascalCase SAP Object Node Type semantic name', minLength: 1, maxLength: 30 },
        description: { type: 'string', description: 'SAP Object Node Type description', minLength: 1, maxLength: 60 },
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        sapObjectTypeName: {
          type: 'string', description: 'Existing active uppercase RONT repository name', minLength: 1, maxLength: 30
        },
        rootNode: { type: 'boolean', description: 'Whether this is the single root node of the referenced SAP Object Type' }
      },
      required: ['name', 'description', 'packageName', 'sapObjectTypeName', 'rootNode', 'transportRequest']
    },
    fixedDefaults: {
      objectType: 'NONT/NOT', shellContentType: 'application/vnd.sap.adt.blues.v2+xml',
      additionalContentType: 'application/vnd.sap.adt.serverdriven.content.v1+json',
      creationFramework: 'newObjectTypes.v1', sourceContentType: 'application/json', formatVersion: '1',
      repositoryNameDerivedAs: 'UPPERCASE', metadataDerivedFromRequest: true,
      sapObjectTypeReferenceUsesRepositoryName: true
    },
    validationRules: [
      'The semantic name must be a 1-30 character PascalCase identifier; the repository identity is its uppercase form.',
      'The referenced SAP Object Type must be supplied as an uppercase RONT repository name and remain active with the same URI and semantic name.',
      'The target must not already exist and the package must remain transportable.',
      'Blue v2 discovery plus $new schema, configuration, and initial content are frozen during preview and revalidated during apply.',
      'The root-node choice is explicit; SAP enforces that one SAP Object Type has at most one root node.',
      'Metadata, base64 payloads, XML, URLs, media types, and derived semantic references cannot be supplied by callers.',
      'Inactive and active metadata/content must preserve the semantic name, referenced SAP Object Type, root-node choice, language, and description.'
    ],
    executionStages: [
      'REVALIDATE_ABSENCE', 'REVALIDATE_REFERENCE', 'REVALIDATE_CONTRACT', 'VALIDATE_TRANSPORT',
      'CREATE_OBJECT', 'VERIFY_INACTIVE_OBJECT', 'VERIFY_INACTIVE_CONTENT', 'ACTIVATE_OBJECT',
      'VERIFY_ACTIVE_OBJECT', 'VERIFY_ACTIVE_CONTENT'
    ],
    compensationLimits: [
      'Only the SAP Object Node Type proven to have been created by the current plan may be deleted.',
      'Unknown Blue shell, activation, or delete outcomes stop automatic retry and compensation.'
    ]
  },
  {
    objectKind: 'CHANGE_DOCUMENT_OBJECT', adtType: 'CHDO/CHD', displayName: 'Change Document Object', family: 'DDIC', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'TARGET_ADT_DISCOVERY', 'REAL_DEV_EXECUTION'],
    requirements: { source: true, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one Change Document Object and verify the Function Module or Class generated by SAP activation.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        name: { type: 'string', description: 'Change Document Object repository name', minLength: 1, maxLength: 15 },
        description: { type: 'string', description: 'Change Document Object description', minLength: 1, maxLength: 60 },
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        category: { type: 'string', enum: ['standard', 'behaviorDefinition'] },
        abapLanguageVersion: { type: 'string', enum: ['standard', 'cloudDevelopment'], description: 'Defaults to standard when omitted' },
        tablesAndStructures: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'Existing active database table or DDIC structure', minLength: 1, maxLength: 30 },
              referenceTable: { type: 'string', description: 'Optional active database table for currency or quantity references', maxLength: 30 },
              multipleChanges: { type: 'boolean', description: 'Defaults to false when omitted' },
              databaseInsertions: {
                type: 'object', additionalProperties: false,
                properties: {
                  logValues: { type: 'boolean', description: 'Defaults to false when omitted' },
                  logInitialValues: { type: 'boolean', description: 'Defaults to false when omitted' }
                }
              },
              databaseDeletions: {
                type: 'object', additionalProperties: false,
                properties: {
                  logValues: { type: 'boolean', description: 'Defaults to false when omitted' },
                  logInitialValues: { type: 'boolean', description: 'Defaults to false when omitted' }
                }
              }
            },
            required: ['name']
          }
        }
      },
      required: ['name', 'description', 'packageName', 'category', 'tablesAndStructures', 'transportRequest']
    },
    fixedDefaults: {
      objectType: 'CHDO/CHD', shellContentType: 'application/vnd.sap.adt.blues.v1+xml',
      schemaFramework: 'objectTypes.v1', sourceContentType: 'application/json', formatVersion: '1',
      generatedObjectAssignedBySap: true, behaviorDefinitionSapValue: 'behaviorDefiniton',
      errorMessageId: 'CD', errorMessageNumber: '600',
      multipleChanges: false, logValues: false, logInitialValues: false
    },
    validationRules: [
      'The Change Document Object name is limited to 15 characters and must be inside the configured namespace allow-list.',
      'The target must not already exist and the package must remain transportable.',
      'Every table or structure, optional reference table, and message class is resolved as an active repository object and frozen during preview.',
      'The public behaviorDefinition category is mapped internally to the behaviorDefiniton value published by SAP ADT 3.60.2.',
      'logInitialValues requires logValues=true for the same insertion or deletion operation.',
      'Callers cannot provide the hidden errorMessage default, generatedObject, JSON, XML, URLs, media types, headers, annotations, or lock handles.',
      'After activation, the target must expose the SAP-assigned active CLAS/OC generated object.'
    ],
    executionStages: [
      'REVALIDATE_ABSENCE', 'REVALIDATE_REFERENCES', 'REVALIDATE_CONTRACT', 'VALIDATE_TRANSPORT',
      'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT', 'LOCK_RESOURCE', 'WRITE_CONTENT', 'VERIFY_CONTENT',
      'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_GENERATED_OBJECT', 'VERIFY_ACTIVE_CONTENT'
    ],
    compensationLimits: [
      'Only an inactive Change Document Object proven to have been created by the current plan may be deleted.',
      'Once activation is attempted, generated Function Module or Class ownership is unknown and no automatic deletion is allowed.',
      'Unknown shell, JSON content, unlock, activation, or post-activation verification outcomes stop retry and compensation.'
    ]
  },
  controlledSourceCapability('ABAP_CLASS', 'CLAS/OC', 'ABAP Class', 'ABAP_OO', [
    'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2'
  ]),
  controlledSourceCapability('ABAP_INTERFACE', 'INTF/OI', 'ABAP Interface', 'ABAP_OO', [
    'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2', 'REAL_DEV_EXECUTION'
  ]),
  controlledSourceCapability('PROGRAM_INCLUDE', 'PROG/I', 'Program Include', 'ABAP_SOURCE', [
    'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2', 'REAL_DEV_EXECUTION'
  ]),
  controlledSourceCapability('CDS_DATA_DEFINITION', 'DDLS/DF', 'CDS Data Definition', 'CDS', [
    'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2', 'VSCODE_ABAP_REMOTE_FS'
  ]),
  controlledSourceCapability('CDS_ACCESS_CONTROL', 'DCLS/DL', 'CDS Access Control', 'CDS', [
    'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2', 'VSCODE_ABAP_REMOTE_FS'
  ]),
  controlledSourceCapability('CDS_METADATA_EXTENSION', 'DDLX/EX', 'CDS Metadata Extension', 'CDS', [
    'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2', 'VSCODE_ABAP_REMOTE_FS'
  ]),
  controlledSourceCapability('CDS_ANNOTATION_DEFINITION', 'DDLA/ADF', 'CDS Annotation Definition', 'CDS', [
    'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2'
  ]),
  controlledSourceCapability('SERVICE_DEFINITION', 'SRVD/SRV', 'Service Definition', 'RAP_SERVICE', [
    'ECLIPSE_ADT_3_60_2', 'ABAP_ADT_API_8_4_2', 'VSCODE_ABAP_REMOTE_FS'
  ]),
  controlledSourceCapability('BEHAVIOR_DEFINITION', 'BDEF/BDO', 'Behavior Definition', 'RAP_BEHAVIOR', [
    'ECLIPSE_ADT_3_60_2', 'VSCODE_ABAP_REMOTE_FS'
  ]),
  controlledSourceCapability('CDS_TYPE', 'DRTY/STY', 'CDS Type', 'CDS', [
    'ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG'
  ]),
  controlledSourceCapability('CDS_ASPECT', 'DRAS/RAS', 'CDS Aspect', 'CDS', [
    'ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG'
  ]),
  controlledSourceCapability('CDS_ENTITY_BUFFER', 'DTEB/DF', 'CDS Entity Buffer', 'CDS', [
    'ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG'
  ]),
  {
    objectKind: 'SERVICE_BINDING', adtType: 'SRVB/SVB', displayName: 'Service Binding', family: 'RAP_SERVICE', parentKind: 'PACKAGE',
    maturity: 'REAL_DEV_VERIFIED', targetAvailable: true,
    evidenceSources: ['ECLIPSE_ADT_3_60_2', 'ECLIPSE_COMMUNICATION_LOG', 'VSCODE_ABAP_REMOTE_FS', 'REAL_DEV_EXECUTION'],
    requirements: { source: false, attributes: true, technicalSettings: false, transportRequest: true, separateActivation: true },
    summary: 'Create one OData service binding for an existing active service definition.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        serviceDefinition: { type: 'string', description: 'Existing active SRVD/SRV service definition', minLength: 1, maxLength: 30 },
        bindingType: { type: 'string', enum: ['ODATA_V2_UI', 'ODATA_V2_WEB_API', 'ODATA_V4_UI', 'ODATA_V4_WEB_API'] },
        bindingCategory: { type: 'string', enum: ['0', '1'], description: '0 for UI, 1 for Web API' }
      },
      required: ['name', 'description', 'packageName', 'serviceDefinition', 'bindingType', 'bindingCategory', 'transportRequest']
    },
    fixedDefaults: { serviceVersion: '0001', protocol: 'ODATA' },
    validationRules: [
      'The target binding must not already exist.',
      'The package must be transportable and the service definition must remain the same active SRVD/SRV object.',
      'ODATA V2/V4 and UI/Web API category must agree with the requested binding type.',
      'The created binding is read back and its service definition and binding configuration are verified.'
    ],
    executionStages: ['REVALIDATE_ABSENCE', 'REVALIDATE_REFERENCE', 'VALIDATE_TRANSPORT', 'CREATE_OBJECT', 'ACTIVATE_OBJECT', 'VERIFY_ACTIVE_OBJECT', 'VERIFY_CONFIGURATION'],
    compensationLimits: [
      'Only the binding proven to have been created by the current plan may be deleted.',
      'Unknown create or delete outcomes stop automatic retry and compensation.'
    ]
  }
];

function controlledSourceCapability(
  objectKind: RepositoryObjectKind,
  adtType: string,
  displayName: string,
  family: string,
  evidenceSources: RepositoryCreationEvidenceSource[]
): RepositoryCreationCapabilityDefinition {
  const requiresReference = objectKind === 'CDS_ACCESS_CONTROL'
    || objectKind === 'CDS_METADATA_EXTENSION'
    || objectKind === 'SERVICE_DEFINITION'
    || objectKind === 'BEHAVIOR_DEFINITION'
    || objectKind === 'CDS_ENTITY_BUFFER';
  return {
    objectKind,
    adtType,
    displayName,
    family,
    parentKind: 'PACKAGE',
    maturity: REAL_DEV_SOURCE_OBJECTS.has(objectKind) ? 'REAL_DEV_VERIFIED' : 'AUTOMATION_VERIFIED',
    targetAvailable: true,
    evidenceSources: REAL_DEV_SOURCE_OBJECTS.has(objectKind)
      ? [...new Set<RepositoryCreationEvidenceSource>([...evidenceSources, 'REAL_DEV_EXECUTION'])]
      : evidenceSources,
    requirements: {
      source: true,
      attributes: true,
      technicalSettings: false,
      transportRequest: true,
      separateActivation: true
    },
    summary: `Create one complete ${displayName} source object in an existing transportable package.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...commonObjectProperties,
        name: {
          type: 'string', description: `${displayName} repository object name`, minLength: 1,
          maxLength: objectKind === 'CDS_TYPE' ? 40 : 30
        },
        packageName: { type: 'string', description: 'Existing transportable package', minLength: 1, maxLength: 30 },
        ...(requiresReference ? {
          referencedObjectName: {
            type: 'string', description: 'Existing active CDS entity or data definition bound by the source',
            minLength: 1, maxLength: 30
          }
        } : {}),
        source: { type: 'string', description: `Complete ${displayName} source`, minLength: 1 }
      },
      required: [
        'name', 'description', 'packageName', 'transportRequest', 'source',
        ...(requiresReference ? ['referencedObjectName'] : [])
      ]
    },
    fixedDefaults: objectKind === 'ABAP_CLASS'
      ? { visibility: 'public', final: true }
      : objectKind === 'SERVICE_DEFINITION'
        ? { sourceType: 'definition' }
        : objectKind === 'BEHAVIOR_DEFINITION'
          ? { variant: 'definition', repositoryNameMatchesRootEntity: true }
          : {},
    validationRules: [
      'The name must be inside the configured namespace allow-list.',
      'The target must not already exist.',
      'Class and interface source must declare the requested object name.',
      ...(objectKind === 'CDS_TYPE' ? ['The source must define the requested CDS type name.'] : []),
      ...(objectKind === 'CDS_ASPECT' ? ['The source must define a complete aspect block with the requested name.'] : []),
      ...(requiresReference ? [
        'The referenced CDS object must exist, remain active, and match the confirmed source at apply time.'
      ] : []),
      ...(objectKind === 'BEHAVIOR_DEFINITION' ? [
        'Only behavior definitions are accepted; extensions remain outside this controlled slice.',
        'The repository object name must match the root CDS entity.'
      ] : []),
      'Source and active metadata must be read back after activation.'
    ],
    executionStages: [
      'REVALIDATE_ABSENCE', ...(requiresReference ? ['REVALIDATE_REFERENCE'] : []),
      'VALIDATE_TRANSPORT', 'CREATE_SHELL', 'RESOLVE_CREATED_OBJECT',
      'LOCK_RESOURCE', 'WRITE_SOURCE', 'RUN_CHECKS', 'UNLOCK_RESOURCE', 'ACTIVATE_OBJECT',
      'VERIFY_ACTIVE_OBJECT', 'VERIFY_SOURCE'
    ],
    compensationLimits: [
      'Only the object proven to have been created by the current plan may be deleted.',
      'Unknown shell, source, unlock, or activation outcomes stop automatic compensation.'
    ]
  };
}
