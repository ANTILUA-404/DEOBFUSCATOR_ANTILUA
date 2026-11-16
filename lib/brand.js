'use strict';

const NAME = 'ANTILUA DEOBFUSCATOR';

/**
 * Credit block for every result file. `details` are [label, value] pairs;
 * empty values are skipped so a profile never emits a dangling label.
 */
function header(details) {
  const lines = [`-- Deobfuscated By ${NAME}`];
  for (const [label, value] of details || []) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`-- ${label}: ${value}`);
  }
  return lines.join('\n') + '\n\n';
}

module.exports = { NAME, header };
