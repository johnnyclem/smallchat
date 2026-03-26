import { describe, it, expect } from 'vitest';
import { extractToolMentions } from './memory-reader.js';

describe('extractToolMentions', () => {
  const knownTools = ['search_code', 'create_issue', 'send_message', 'read_file'];

  it('finds tool mentions in memory content', () => {
    const content = `# Project Notes
Always use search_code for finding implementations.
The create_issue tool is useful for tracking bugs.`;

    const mentions = extractToolMentions(content, knownTools, 'test.md');
    expect(mentions.length).toBe(2);
    expect(mentions[0].toolName).toBe('search_code');
    expect(mentions[1].toolName).toBe('create_issue');
  });

  it('infers positive sentiment from keywords', () => {
    const content = 'The search_code tool works well and is very useful.';
    const mentions = extractToolMentions(content, knownTools, 'test.md');
    expect(mentions[0].sentiment).toBe('positive');
  });

  it('infers negative sentiment from keywords', () => {
    const content = "Avoid using send_message — it's broken and unreliable.";
    const mentions = extractToolMentions(content, knownTools, 'test.md');
    expect(mentions[0].sentiment).toBe('negative');
  });

  it('infers neutral sentiment when no keywords match', () => {
    const content = 'The read_file tool exists in the codebase.';
    const mentions = extractToolMentions(content, knownTools, 'test.md');
    expect(mentions[0].sentiment).toBe('neutral');
  });

  it('returns empty array when no tools are mentioned', () => {
    const content = 'This file has no tool mentions at all.';
    const mentions = extractToolMentions(content, knownTools, 'test.md');
    expect(mentions).toEqual([]);
  });

  it('captures surrounding context', () => {
    const content = `line before
search_code is the best
line after`;
    const mentions = extractToolMentions(content, knownTools, 'test.md');
    expect(mentions[0].context).toContain('line before');
    expect(mentions[0].context).toContain('search_code');
    expect(mentions[0].context).toContain('line after');
  });

  it('records the source file path', () => {
    const content = 'Use search_code for everything.';
    const mentions = extractToolMentions(content, knownTools, '/home/.claude/CLAUDE.md');
    expect(mentions[0].source).toBe('/home/.claude/CLAUDE.md');
  });

  it('handles mixed positive and negative as neutral', () => {
    const content = "search_code is useful but sometimes it doesn't work properly.";
    const mentions = extractToolMentions(content, knownTools, 'test.md');
    // "useful" = positive, "doesn't work" = negative → neutral
    expect(mentions[0].sentiment).toBe('neutral');
  });
});
