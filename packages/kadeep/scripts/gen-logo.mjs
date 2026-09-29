#!/usr/bin/env node
// Regenerate KS_MARK in src/ui/logo.mjs from the logo SVG's circle grid (dev only; not published).
//   node scripts/gen-logo.mjs ../../.github/assets/kadeep-studios-logo.svg
import { readFileSync } from 'node:fs'

const svg = readFileSync(process.argv[2] ?? '../../.github/assets/kadeep-studios-logo.svg', 'utf8')
const dots = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])])
const xs = [...new Set(dots.map(([x]) => Math.round(x)))].sort((a, b) => a - b)
const step = Math.min(...xs.slice(1).map((x, i) => x - xs[i]).filter((d) => d > 1))
const x0 = Math.min(...dots.map(([x]) => x))
const y0 = Math.min(...dots.map(([, y]) => y))
const cols = Math.round((Math.max(...dots.map(([x]) => x)) - x0) / step) + 1
const rows = Math.round((Math.max(...dots.map(([, y]) => y)) - y0) / step) + 1
const grid = Array.from({ length: rows }, () => Array(cols).fill('.'))
for (const [x, y] of dots) grid[Math.round((y - y0) / step)][Math.round((x - x0) / step)] = '#'
console.log(`// ${dots.length} dots, ${cols} × ${rows}`)
console.log(`export const KS_MARK = [${grid.map((r) => `'${r.join('')}'`).join(', ')}]`)
