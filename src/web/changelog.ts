import text from './CHANGELOG.md?raw'

export type Block = { kind: 'heading'; text: string } | { kind: 'text'; text: string } | { kind: 'list'; items: string[] }

// The file as written: # headings, - or * bullets, and every other line as text
function parse(source: string): Block[] {
  const blocks: Block[] = []
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#+\s+(.*)$/.exec(line)
    const item = /^[-*]\s+(.*)$/.exec(line)
    const last = blocks[blocks.length - 1]
    if (heading) blocks.push({ kind: 'heading', text: heading[1] })
    else if (!item) blocks.push({ kind: 'text', text: line })
    else if (last?.kind === 'list') last.items.push(item[1])
    else blocks.push({ kind: 'list', items: [item[1]] })
  }
  return blocks
}

export const changelog = parse(text)
