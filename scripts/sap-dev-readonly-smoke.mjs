import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const programSourceUrl = '/sap/bc/adt/programs/programs/zcodex_mcp_test/source/main';
const includeSourceUrl = '/sap/bc/adt/programs/includes/zcodex_mcp_test_i01/source/main';

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
);

Object.assign(childEnvironment, {
  SAP_MCP_TOOL_PROFILE: 'legacy-full',
  SAP_MCP_ADT_TIMEOUT_MS: '60000',
  SAP_MCP_MAX_CONCURRENT_TOOLS: '1',
  SAP_MCP_MAX_QUEUED_TOOLS: '1',
  SAP_MCP_QUERY_DEFAULT_ROWS: '5',
  SAP_MCP_QUERY_MAX_ROWS: '5000',
  SAP_MCP_SEARCH_DEFAULT_RESULTS: '3',
  SAP_MCP_SEARCH_MAX_RESULTS: '5',
  SAP_MCP_MAX_RESPONSE_BYTES: '1048576',
  SAP_MCP_SOURCE_CACHE_MAX_ENTRIES: '1',
  SAP_MCP_SOURCE_CACHE_MAX_ITEM_BYTES: '65536',
  SAP_MCP_SOURCE_CACHE_TTL_SECONDS: '60',
  SAP_MCP_LOG_LEVEL: 'warn'
});

const client = new Client({ name: 'sap-dev-readonly-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['./dist/index.js'],
  cwd: process.cwd(),
  env: childEnvironment,
  stderr: 'pipe'
});

const results = [];
const verifyTtl = process.argv.includes('--verify-ttl');

function record(name, passed, details) {
  results.push({ name, passed, details });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${name}: ${details}\n`);
}

function textPayload(result) {
  return (result.content || [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
}

function parsedPayload(result) {
  const text = textPayload(result);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function callReadOnlyTool(name, args) {
  const allowed = new Set(['searchObject', 'tableContents', 'getObjectSource']);
  if (!allowed.has(name)) throw new Error(`Tool '${name}' is outside the read-only smoke-test allowlist.`);
  return client.callTool({ name, arguments: args });
}

async function testArgumentLimits() {
  const queryResult = await callReadOnlyTool('tableContents', {
    ddicEntityName: 'TSTC',
    rowNumber: 5001,
    decode: true
  });
  const queryText = textPayload(queryResult);
  record('query hard limit', queryResult.isError === true && queryText.includes('rowNumber') && queryText.includes('5000'), 'rowNumber=5001 is rejected before SAP execution');

  const searchResult = await callReadOnlyTool('searchObject', { query: 'ZCODEX*', max: 6 });
  const searchText = textPayload(searchResult);
  record('search hard limit', searchResult.isError === true && searchText.includes('max') && searchText.includes('5'), 'max=6 is rejected before SAP execution');

  const defaultSearch = await callReadOnlyTool('searchObject', { query: 'ZCODEX*' });
  const defaultSearchPayload = parsedPayload(defaultSearch);
  const searchCount = Array.isArray(defaultSearchPayload.results) ? defaultSearchPayload.results.length : -1;
  record('search default limit', defaultSearch.isError !== true && searchCount <= 3, `returned=${searchCount}, configuredDefault=3`);

  const requestedRows = [1, 2, 5, 10];
  const queryCounts = [];
  for (const rowNumber of requestedRows) {
    const queryResult = await callReadOnlyTool('tableContents', {
      ddicEntityName: 'TSTC',
      rowNumber,
      decode: true
    });
    const queryPayload = parsedPayload(queryResult);
    queryCounts.push(Array.isArray(queryPayload.result?.values) ? queryPayload.result.values.length : -1);
  }
  const sapReturnsLookaheadRow = queryCounts.every((count, index) => count === requestedRows[index] + 1);
  record('query limit forwarded to SAP', sapReturnsLookaheadRow, `requested=${requestedRows.join(',')}, returned=${queryCounts.join(',')} (SAP ADT lookahead row)`);

  const defaultQuery = await callReadOnlyTool('tableContents', {
    ddicEntityName: 'TSTC',
    decode: true
  });
  const defaultQueryPayload = parsedPayload(defaultQuery);
  const defaultQueryCount = Array.isArray(defaultQueryPayload.result?.values) ? defaultQueryPayload.result.values.length : -1;
  record('query default limit', defaultQuery.isError !== true && defaultQueryCount === 6, `returned=${defaultQueryCount}, configuredDefault=5 plus SAP ADT lookahead row`);
}

async function getSourcePage(url, startLine) {
  const result = await callReadOnlyTool('getObjectSource', {
    objectSourceUrl: url,
    startLine,
    maxLines: 2
  });
  if (result.isError) throw new Error(textPayload(result));
  return parsedPayload(result);
}

async function testSourceCache() {
  const firstProgramPage = await getSourcePage(programSourceUrl, 1);
  const secondProgramPage = await getSourcePage(programSourceUrl, 3);
  record('source cache hit', firstProgramPage.sourceOrigin === 'sap' && secondProgramPage.sourceOrigin === 'cache', `origins=${firstProgramPage.sourceOrigin},${secondProgramPage.sourceOrigin}`);

  const includePage = await getSourcePage(includeSourceUrl, 1);
  const programAfterEviction = await getSourcePage(programSourceUrl, 1);
  record('source cache LRU eviction', includePage.sourceOrigin === 'sap' && programAfterEviction.sourceOrigin === 'sap', `origins=${includePage.sourceOrigin},${programAfterEviction.sourceOrigin}`);

  if (verifyTtl) {
    await new Promise(resolve => setTimeout(resolve, 61_000));
    const programAfterTtl = await getSourcePage(programSourceUrl, 1);
    record('source cache TTL expiry', programAfterTtl.sourceOrigin === 'sap', `origin=${programAfterTtl.sourceOrigin} after 61 seconds`);
  }
}

async function testResponseLimit() {
  // DD03L contains dictionary metadata only and is wide enough to exercise the 1 MiB MCP response ceiling.
  const result = await callReadOnlyTool('tableContents', {
    ddicEntityName: 'DD03L',
    rowNumber: 5000,
    decode: true
  });
  const text = textPayload(result);
  const responseLimited = text.includes('configured byte limit');
  const returnedBytes = Buffer.byteLength(text, 'utf8');
  record('response byte limit', responseLimited, responseLimited ? 'oversized SAP metadata response replaced with 413' : `limit not reached; returnedBytes=${returnedBytes}`);
}

async function testQueue() {
  const completionOrder = [];
  const query = async (label, ddicEntityName) => {
    const result = await callReadOnlyTool('tableContents', {
      ddicEntityName,
      rowNumber: 100,
      decode: true
    });
    completionOrder.push(label);
    return result;
  };
  const startedAt = Date.now();
  const concurrent = await Promise.all([
    query('A', 'TSTCT'),
    query('B', 'TSTC'),
    query('C', 'DD02L')
  ]);
  const elapsedMs = Date.now() - startedAt;
  const texts = concurrent.map(textPayload);
  const queueFullCount = texts.filter(text => text.includes('Tool execution queue is full')).length;
  const fifoObserved = concurrent[0].isError !== true
    && concurrent[1].isError !== true
    && texts[2].includes('Tool execution queue is full')
    && completionOrder.indexOf('A') < completionOrder.indexOf('B');
  record('single-process FIFO queue', fifoObserved && queueFullCount === 1, `completion=${completionOrder.join('>')}, queueFull=${queueFullCount}, elapsedMs=${elapsedMs}`);
}

async function main() {
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const available = new Set(tools.tools.map(tool => tool.name));
    for (const required of ['searchObject', 'tableContents', 'getObjectSource']) {
      if (!available.has(required)) throw new Error(`Required legacy read tool '${required}' is unavailable.`);
    }

    await testArgumentLimits();
    await testSourceCache();
    await testResponseLimit();
    await testQueue();
  } finally {
    await transport.close();
  }

  const failed = results.filter(result => !result.passed);
  if (failed.length > 0) {
    if (stderr.trim()) process.stderr.write('MCP child stderr contained diagnostic output; inspect locally if needed.\n');
    process.exitCode = 1;
  }
}

main().catch(async error => {
  process.stderr.write(`Smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`);
  try { await transport.close(); } catch {}
  process.exitCode = 1;
});
