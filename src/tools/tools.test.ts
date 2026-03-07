import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'path'
import { createToolRegistry } from './registry'
import { createBashTool } from './bash'
import { createReadFileTool } from './read-file'
import { createWriteFileTool } from './write-file'
import { createEditFileTool } from './edit-file'
import { createListFilesTool } from './list-files'
import { createGrepTool } from './grep'
import { createGlobTool } from './glob'
import { ToolRouter, createToolRouter } from './router'
import type { ToolsConfig } from '../config/schema'
import type { ToolDefinition } from './types'

// Test configuration with permissive settings for testing
const testConfig: ToolsConfig = {
  allowedDirectories: ['$HOME'],
  blockedCommands: ['rm -rf', 'sudo', 'su', 'curl', 'wget'],
  maxBashTimeout: 10_000,
  maxFileSize: 1_048_576,
  maxIterations: 50,
}

// Helper to create a temporary directory for file operations
async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp('/tmp/opencrow-tool-test-')
  return tempDir
}

// Helper to cleanup temp directory
async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

describe('Bash Tool', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  test('execute simple command', async () => {
    const bashTool = createBashTool(testConfig)
    const result = await bashTool.execute({ command: 'echo "Hello World"' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Hello World')
  })

  test('execute command with exit code', async () => {
    const bashTool = createBashTool(testConfig)
    const result = await bashTool.execute({ command: 'exit 0' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('exit code: 0')
  })

  test('capture stderr on error', async () => {
    const bashTool = createBashTool(testConfig)
    const result = await bashTool.execute({ command: 'ls /nonexistent/path' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('stderr')
  })

  test('reject blocked commands', async () => {
    const bashTool = createBashTool(testConfig)
    const result = await bashTool.execute({ command: 'sudo whoami' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('blocked for safety')
  })

  test('empty command returns error', async () => {
    const bashTool = createBashTool(testConfig)
    const result = await bashTool.execute({ command: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('empty command')
  })

  test('pipe commands work', async () => {
    const bashTool = createBashTool(testConfig)
    const result = await bashTool.execute({
      command: 'echo "hello world" | grep "world"',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('world')
  })

  test('environment variables accessible', async () => {
    const bashTool = createBashTool(testConfig)
    const result = await bashTool.execute({ command: 'echo $HOME' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(process.env.HOME ?? '')
  })
})

describe('Read File Tool', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  test('read existing file', async () => {
    const testFile = join(tempDir, 'test.txt')
    const content = 'Hello, World!'
    await writeFile(testFile, content)

    const readTool = createReadFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await readTool.execute({ path: testFile })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Hello, World!')
  })

  test('read non-existent file returns error', async () => {
    const readTool = createReadFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await readTool.execute({ path: join(tempDir, 'nonexistent.txt') })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('file not found')
  })

  test('read file with line range', async () => {
    const testFile = join(tempDir, 'multiline.txt')
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5'
    await writeFile(testFile, content)

    const readTool = createReadFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await readTool.execute({
      path: testFile,
      startLine: 2,
      endLine: 4,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Line 2')
    expect(result.output).toContain('Line 4')
    expect(result.output).not.toContain('Line 1')
    expect(result.output).not.toContain('Line 5')
  })

  test('invalid startLine returns error', async () => {
    const testFile = join(tempDir, 'test.txt')
    await writeFile(testFile, 'content')

    const readTool = createReadFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await readTool.execute({
      path: testFile,
      startLine: 0, // Invalid: must be 1-indexed
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('positive integer')
  })

  test('invalid endLine returns error', async () => {
    const testFile = join(tempDir, 'test.txt')
    await writeFile(testFile, 'content')

    const readTool = createReadFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await readTool.execute({
      path: testFile,
      startLine: 5,
      endLine: 2, // Invalid: less than startLine
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('endLine must be an integer >= startLine')
  })

  test('large file truncation', async () => {
    const testFile = join(tempDir, 'large.txt')
    const largeContent = 'x'.repeat(2_000_000) // 2MB, exceeds default 1MB limit
    await writeFile(testFile, largeContent)

    const readTool = createReadFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
      maxFileSize: 1_048_576, // 1MB
    })
    const result = await readTool.execute({ path: testFile })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Truncated')
  })
})

describe('Write File Tool', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  test('write new file', async () => {
    const testFile = join(tempDir, 'newfile.txt')
    const content = 'New file content'

    const writeTool = createWriteFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await writeTool.execute({
      path: testFile,
      content: content,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Successfully wrote')

    // Verify file exists and has correct content
    const writtenContent = await Bun.file(testFile).text()
    expect(writtenContent).toBe(content)
  })

  test('overwrite existing file', async () => {
    const testFile = join(tempDir, 'existing.txt')
    await writeFile(testFile, 'Old content')

    const writeTool = createWriteFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await writeTool.execute({
      path: testFile,
      content: 'New content',
    })

    expect(result.isError).toBe(false)

    const writtenContent = await Bun.file(testFile).text()
    expect(writtenContent).toBe('New content')
  })

  test('path outside allowed directory returns error', async () => {
    const writeTool = createWriteFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await writeTool.execute({
      path: '/etc/passwd',
      content: 'malicious',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('not allowed')
  })
})

describe('Edit File Tool', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  test('single edit', async () => {
    const testFile = join(tempDir, 'edit.txt')
    const content = 'Hello World\nSecond line'
    await writeFile(testFile, content)

    const editTool = createEditFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await editTool.execute({
      path: testFile,
      old_string: 'World',
      new_string: 'OpenCrow',
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Edited')

    const editedContent = await Bun.file(testFile).text()
    expect(editedContent).toContain('Hello OpenCrow')
  })

  test('multiple sequential edits', async () => {
    const testFile = join(tempDir, 'multi.txt')
    const content = 'First\nSecond\nThird'
    await writeFile(testFile, content)

    const editTool = createEditFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })

    // First edit
    await editTool.execute({
      path: testFile,
      old_string: 'First',
      new_string: 'ONE',
    })

    // Second edit
    const result = await editTool.execute({
      path: testFile,
      old_string: 'Third',
      new_string: 'THREE',
    })

    expect(result.isError).toBe(false)

    const editedContent = await Bun.file(testFile).text()
    expect(editedContent).toBe('ONE\nSecond\nTHREE')
  })

  test('non-matching old_string returns error', async () => {
    const testFile = join(tempDir, 'nomatch.txt')
    await writeFile(testFile, 'Original content')

    const editTool = createEditFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await editTool.execute({
      path: testFile,
      old_string: 'Nonexistent',
      new_string: 'Replacement',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('old_string not found')
  })

  test('missing old_string returns error', async () => {
    const testFile = join(tempDir, 'empty.txt')
    await writeFile(testFile, 'Content')

    const editTool = createEditFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await editTool.execute({
      path: testFile,
      old_string: '',
      new_string: 'New',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('old_string is required')
  })

  test('identical old and new strings returns error', async () => {
    const testFile = join(tempDir, 'same.txt')
    await writeFile(testFile, 'Content')

    const editTool = createEditFileTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await editTool.execute({
      path: testFile,
      old_string: 'Content',
      new_string: 'Content',
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('identical')
  })
})

describe('List Files Tool', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir()
    // Create test structure
    await writeFile(join(tempDir, 'file1.txt'), 'content1')
    await writeFile(join(tempDir, 'file2.ts'), 'content2')
    await Bun.write(join(tempDir, 'file3.js'), 'content3')
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  test('list files in directory', async () => {
    const listTool = createListFilesTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await listTool.execute({ path: tempDir })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('file1.txt')
    expect(result.output).toContain('file2.ts')
    expect(result.output).toContain('file3.js')
  })

  test('list files recursive', async () => {
    const subDir = join(tempDir, 'sub')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'nested.txt'), 'nested')

    const listTool = createListFilesTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await listTool.execute({
      path: tempDir,
      recursive: true,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('sub')
    expect(result.output).toContain('nested.txt')
  })

  test('non-existent path returns error', async () => {
    const listTool = createListFilesTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await listTool.execute({
      path: join(tempDir, 'nonexistent'),
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Error listing directory')
  })
})

describe('Grep Tool', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir()
    await writeFile(join(tempDir, 'search.txt'), 'Hello World\nFoo Bar\nHello Again')
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  test('search for pattern', async () => {
    const grepTool = createGrepTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await grepTool.execute({
      pattern: 'Hello',
      path: tempDir,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Hello')
  })

  test('no matches found', async () => {
    const grepTool = createGrepTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await grepTool.execute({
      pattern: 'Nonexistent',
      path: tempDir,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toBe('No matches found.')
  })

  test('empty pattern returns error', async () => {
    const grepTool = createGrepTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await grepTool.execute({ pattern: '' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('pattern is required')
  })

  test('case insensitive search', async () => {
    const grepTool = createGrepTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await grepTool.execute({
      pattern: 'hello',
      path: tempDir,
      ignoreCase: true,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Hello')
  })

  test('limit results', async () => {
    const grepTool = createGrepTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await grepTool.execute({
      pattern: '.',
      path: tempDir,
      maxResults: 1,
    })

    expect(result.isError).toBe(false)
    const lines = result.output.split('\n').filter(l => !l.startsWith('['))
    expect(lines.length).toBeLessThanOrEqual(1)
  })
})

describe('Glob Tool', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir()
    await writeFile(join(tempDir, 'root.ts'), 'root')
    await Bun.write(join(tempDir, 'nested.js'), 'nested')
    const subDir = join(tempDir, 'sub')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'deep.ts'), 'deep')
    await writeFile(join(subDir, 'another.js'), 'another')
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  test('glob for files', async () => {
    const globTool = createGlobTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await globTool.execute({
      pattern: '**/*.ts',
      path: tempDir,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('root.ts')
    expect(result.output).toContain('deep.ts')
  })

  test('glob with no matches', async () => {
    const globTool = createGlobTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await globTool.execute({
      pattern: '**/*.nonexistent',
      path: tempDir,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toBe('No files matched.')
  })

  test('invalid pattern returns error', async () => {
    const globTool = createGlobTool({
      ...testConfig,
      allowedDirectories: [tempDir],
    })
    const result = await globTool.execute({ pattern: '' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('pattern is required')
  })
})

describe('Tool Router', () => {
  const mockTools: ToolDefinition[] = [
    {
      name: 'research_tool',
      description: 'Search for information on the web, news, articles',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      categories: ['research'],
      execute: async () => ({ output: 'research result', isError: false }),
    },
    {
      name: 'code_tool',
      description: 'Read, write, edit code files, implement features',
      inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
      categories: ['code', 'fileops'],
      execute: async () => ({ output: 'code result', isError: false }),
    },
    {
      name: 'analytics_tool',
      description: 'Get usage metrics, performance stats, error rates',
      inputSchema: { type: 'object', properties: { metric: { type: 'string' } } },
      categories: ['analytics'],
      execute: async () => ({ output: 'analytics result', isError: false }),
    },
    {
      name: 'memory_tool',
      description: 'Remember, recall, search observations and preferences',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
      categories: ['memory'],
      execute: async () => ({ output: 'memory result', isError: false }),
    },
  ]

  describe('detectIntent', () => {
    test('research intent', () => {
      const intent = ToolRouter.detectIntent('Search for news about AI')
      expect(intent).toContain('research')
    })

    test('code intent', () => {
      const intent = ToolRouter.detectIntent('Write a function to sort array')
      expect(intent).toContain('code')
    })

    test('analytics intent', () => {
      const intent = ToolRouter.detectIntent('Show me the error rate metrics')
      expect(intent).toContain('analytics')
    })

    test('fileops intent', () => {
      const intent = ToolRouter.detectIntent('List all files in directory')
      expect(intent).toContain('fileops')
    })

    test('system intent', () => {
      const intent = ToolRouter.detectIntent('Restart the process')
      expect(intent).toContain('system')
    })

    test('memory intent', () => {
      const intent = ToolRouter.detectIntent('What do you remember about my preferences?')
      expect(intent).toContain('memory')
    })

    test('ideas intent', () => {
      const intent = ToolRouter.detectIntent('Generate a new app idea')
      expect(intent).toContain('ideas')
    })

    test('deploy intent', () => {
      const intent = ToolRouter.detectIntent('Push to production')
      expect(intent).toContain('deploy')
    })

    test('default intent when no match', () => {
      const intent = ToolRouter.detectIntent('Hello there')
      expect(intent).toEqual(['research', 'code'])
    })

    test('multiple intents', () => {
      const intent = ToolRouter.detectIntent('Search github for a code repository')
      expect(intent).toContain('research')
      expect(intent).toContain('code')
    })
  })

  describe('extractKeywords', () => {
    test('extract meaningful keywords', () => {
      const keywords = ToolRouter.extractKeywords('Search for React performance issues')
      expect(keywords).toContain('react')
      expect(keywords).toContain('performance')
      expect(keywords).toContain('issues')
    })

    test('filter common stopwords', () => {
      const keywords = ToolRouter.extractKeywords('The quick brown fox')
      expect(keywords).not.toContain('the')
    })

    test('handle short messages', () => {
      const keywords = ToolRouter.extractKeywords('Hi')
      expect(keywords).toHaveLength(0)
    })
  })

  describe('getRelevantTools', () => {
    test('returns tools matching intent', () => {
      const router = createToolRouter(mockTools)
      const tools = router.getRelevantTools(['research'], [], 10)

      expect(tools.length).toBeGreaterThan(0)
      expect(tools[0]?.name).toBe('research_tool')
    })

    test('returns tools matching keywords', () => {
      const router = createToolRouter(mockTools)
      const tools = router.getRelevantTools([], ['code', 'edit'], 10)

      expect(tools.length).toBeGreaterThan(0)
      expect(tools[0]?.name).toBe('code_tool')
    })

    test('respects limit', () => {
      const router = createToolRouter(mockTools)
      const tools = router.getRelevantTools([], [], 2)

      expect(tools.length).toBeLessThanOrEqual(2)
    })

    test('records execution history', () => {
      const router = createToolRouter(mockTools)
      router.recordExecution('code_tool', true)
      router.recordExecution('code_tool', true)
      router.recordExecution('research_tool', false)

      // Code tool should rank higher due to success history
      const tools = router.getRelevantTools([], [], 10)
      const codeIndex = tools.findIndex(t => t.name === 'code_tool')
      const researchIndex = tools.findIndex(t => t.name === 'research_tool')

      expect(codeIndex).toBeLessThan(researchIndex)
    })

    test('recency boost for recent successful tools', () => {
      const router = createToolRouter(mockTools)

      // Record recent successful execution
      router.recordExecution('analytics_tool', true)

      const tools = router.getRelevantTools([], [], 10)
      const analyticsIndex = tools.findIndex(t => t.name === 'analytics_tool')

      // Should be boosted due to recency
      expect(analyticsIndex).toBeLessThan(3)
    })
  })

  describe('setTools', () => {
    test('update tools list', () => {
      const router = createToolRouter([])
      const newTools: ToolDefinition[] = [
        {
          name: 'new_tool',
          description: 'A new tool',
          inputSchema: { type: 'object', properties: {} },
          categories: ['code'],
          execute: async () => ({ output: 'new', isError: false }),
        },
      ]

      router.setTools(newTools)
      const tools = router.getRelevantTools([], [], 10)

      expect(tools.length).toBe(1)
      expect(tools[0]?.name).toBe('new_tool')
    })
  })
})

describe('Tool Registry', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await createTempDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tempDir)
  })

  test('create registry with default tools', () => {
    const registry = createToolRegistry(testConfig)

    expect(registry.definitions.length).toBeGreaterThan(0)
    const toolNames = registry.definitions.map(t => t.name)
    expect(toolNames).toContain('bash')
    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('write_file')
  })

  test('getAnthropicTools returns proper format', () => {
    const registry = createToolRegistry(testConfig)
    const anthropicTools = registry.getAnthropicTools()

    expect(anthropicTools.length).toBeGreaterThan(0)
    const bashTool = anthropicTools.find(t => t.name === 'bash')
    expect(bashTool).toBeDefined()
    expect(bashTool?.description).toBeDefined()
    expect(bashTool?.input_schema).toBeDefined()
  })

  test('getOpenAITools returns proper format', () => {
    const registry = createToolRegistry(testConfig)
    const openAiTools = registry.getOpenAITools()

    expect(openAiTools.length).toBeGreaterThan(0)
    const bashTool = openAiTools.find(t => t.function.name === 'bash')
    expect(bashTool).toBeDefined()
    expect(bashTool?.type).toBe('function')
    expect(bashTool?.function.description).toBeDefined()
    expect(bashTool?.function.parameters).toBeDefined()
  })

  test('executeTool with invalid tool name', async () => {
    const registry = createToolRegistry(testConfig)

    const result = await registry.executeTool('nonexistent_tool', {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('is not a valid tool')
  })

  test('withFilter allowlist', () => {
    const registry = createToolRegistry(testConfig)
    const filtered = registry.withFilter({
      mode: 'allowlist',
      tools: ['bash'],
    })

    expect(filtered.definitions.length).toBe(1)
    expect(filtered.definitions[0]?.name).toBe('bash')
  })

  test('withFilter blocklist', () => {
    const registry = createToolRegistry(testConfig)
    const originalCount = registry.definitions.length
    const filtered = registry.withFilter({
      mode: 'blocklist',
      tools: ['bash'],
    })

    expect(filtered.definitions.length).toBe(originalCount - 1)
    const toolNames = filtered.definitions.map(t => t.name)
    expect(toolNames).not.toContain('bash')
  })

  test('withFilter all mode returns all tools', () => {
    const registry = createToolRegistry(testConfig)
    const filtered = registry.withFilter({ mode: 'all', tools: [] })

    expect(filtered.definitions.length).toBe(registry.definitions.length)
  })

  test('withTools adds extra tools', () => {
    const registry = createToolRegistry(testConfig)
    const originalCount = registry.definitions.length

    const extraTool: ToolDefinition = {
      name: 'custom_tool',
      description: 'A custom tool',
      inputSchema: { type: 'object', properties: {} },
      categories: ['code'],
      execute: async () => ({ output: 'custom', isError: false }),
    }

    const extended = registry.withTools([extraTool])
    expect(extended.definitions.length).toBe(originalCount + 1)

    const toolNames = extended.definitions.map(t => t.name)
    expect(toolNames).toContain('custom_tool')
  })

  test('recordToolExecution tracks history', () => {
    const registry = createToolRegistry(testConfig)

    registry.recordToolExecution('bash', true)
    registry.recordToolExecution('bash', true)
    registry.recordToolExecution('read_file', false)

    // Should not throw
    expect(() => {
      registry.getRelevantTools(['code'], [], 10)
    }).not.toThrow()
  })

  test('getRelevantTools returns filtered tools', () => {
    const registry = createToolRegistry(testConfig)

    const tools = registry.getRelevantTools(['code'], [], 5)

    expect(tools.length).toBeLessThanOrEqual(5)
    // Code-related tools should be prioritized
    const codeTools = tools.filter(t => t.categories.includes('code'))
    expect(codeTools.length).toBeGreaterThan(0)
  })
})
