#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_URL = "https://ftp.ncbi.nlm.nih.gov/pubmed/J_Entrez.txt";

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    url: DEFAULT_URL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--input":
        args.input = argv[++i] ?? null;
        break;
      case "--output":
        args.output = argv[++i] ?? null;
        break;
      case "--url":
        args.url = argv[++i] ?? DEFAULT_URL;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseRecords(text) {
  const records = [];
  const blocks = text.split(
    "--------------------------------------------------------",
  );

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const record = {};
    for (const line of lines) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      record[key] = value;
    }
    records.push(record);
  }

  return records;
}

function buildMap(records) {
  const table = new Map();
  const conflicts = new Map();
  let skipped = 0;

  for (const record of records) {
    const title = record.JournalTitle?.trim();
    const medAbbr = record.MedAbbr?.trim();
    const nlmId = record.NlmId?.trim() ?? "";

    if (!title || !medAbbr) {
      skipped += 1;
      continue;
    }

    const normalized = normalizeTitle(title);
    if (!normalized) {
      skipped += 1;
      continue;
    }

    const existing = table.get(normalized);
    if (!existing) {
      table.set(normalized, { abbr: medAbbr, title, nlmId });
      continue;
    }

    if (existing.abbr !== medAbbr) {
      const values = conflicts.get(normalized) ?? [
        `${existing.title} => ${existing.abbr}`,
      ];
      values.push(`${title} => ${medAbbr}`);
      conflicts.set(normalized, values);
    }
  }

  for (const normalized of conflicts.keys()) {
    table.delete(normalized);
  }

  return { table, skipped, conflicts };
}

function renderTs(table) {
  const lines = [
    "// Generated from NLM J_Entrez.txt by scripts/generate-nlm-data.mjs.",
    "// Uses JournalTitle => MedAbbr mappings with normalized title keys.",
    "const journal_abbr = {",
  ];

  for (const [title, payload] of [...table.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`  ${JSON.stringify(title)}: ${JSON.stringify(payload.abbr)},`);
  }

  lines.push("};", "", "export { journal_abbr };", "");
  return lines.join("\n");
}

async function loadSource(args) {
  if (args.input) {
    return readFile(args.input, "utf8");
  }

  const response = await fetch(args.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${args.url}: ${response.status}`);
  }

  return response.text();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) {
    throw new Error("Missing required --output <file> argument");
  }

  const text = await loadSource(args);
  const records = parseRecords(text);
  const { table, skipped, conflicts } = buildMap(records);
  await writeFile(args.output, renderTs(table), "utf8");

  if (conflicts.size > 0) {
    const preview = [...conflicts.entries()]
      .slice(0, 10)
      .map(
        ([title, values]) =>
          `${title}\n  - ${[...new Set(values)].join("\n  - ")}`,
      )
      .join("\n");
    console.warn(
      `Dropped ${conflicts.size} ambiguous normalized titles from NLM output.\n${preview}`,
    );
  }

  console.log(
    `Generated ${table.size} entries from ${records.length} records (${skipped} skipped) to ${args.output}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
