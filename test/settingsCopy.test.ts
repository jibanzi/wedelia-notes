import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

describe('Wedelia Notes setup copy', () => {
  it('asks for the password before the enable switch', () => {
    expect(source.indexOf(".setName('Connection password')"))
      .toBeLessThan(source.indexOf(".setName('Let Wedelia search this vault')"));
  });

  it('keeps raw relay errors out of the settings status', () => {
    expect(source).not.toContain('text: `Status: ${this.plugin.settings.status');
    expect(source).not.toContain('note(`${stage}: ${detail}`)');
    expect(source).toContain("note('needs-attention')");
    expect(source).toContain('Check the password and network');
  });
});
