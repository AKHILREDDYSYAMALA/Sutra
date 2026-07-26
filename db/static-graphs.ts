import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type StaticNode = {
  id: string;
  label: string;
  type: string;
  named?: boolean;
};

export type StaticEdge = {
  source: string;
  target: string;
  relation: string;
  exposure_pct: number | null;
  risk_flag: "high" | "medium" | "low" | null;
  source_quote: string;
  source_page: number | null;
  confidence: "high" | "medium";
};

export type StaticGraph = {
  target_company: string;
  rating: string | null;
  report_date: string;
  agency: string | null;
  nodes: StaticNode[];
  edges: StaticEdge[];
  key_risks: string[];
};

export type StaticGraphFile = {
  fileName: string;
  slug: string;
  hash: string;
  graph: StaticGraph;
};

const graphDirectory = path.resolve(process.cwd(), "data/companies");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null.`);
  return value;
}

function parseNode(value: unknown, fileName: string, index: number): StaticNode {
  if (!isRecord(value)) throw new Error(`${fileName}: node ${index} must be an object.`);

  if (value.named !== undefined && typeof value.named !== "boolean") {
    throw new Error(`${fileName}: node ${index}.named must be boolean when present.`);
  }

  return {
    id: requiredString(value.id, `${fileName}: node ${index}.id`),
    label: requiredString(value.label, `${fileName}: node ${index}.label`),
    type: requiredString(value.type, `${fileName}: node ${index}.type`),
    named: value.named as boolean | undefined,
  };
}

function parseEdge(value: unknown, fileName: string, index: number): StaticEdge {
  if (!isRecord(value)) throw new Error(`${fileName}: edge ${index} must be an object.`);

  const exposure = value.exposure_pct;
  if (exposure !== null && typeof exposure !== "number") {
    throw new Error(`${fileName}: edge ${index}.exposure_pct must be a number or null.`);
  }
  if (typeof exposure === "number" && (!Number.isFinite(exposure) || exposure < 0 || exposure > 100)) {
    throw new Error(`${fileName}: edge ${index}.exposure_pct must be between 0 and 100.`);
  }

  const riskFlag = value.risk_flag;
  if (riskFlag !== null && riskFlag !== "high" && riskFlag !== "medium" && riskFlag !== "low") {
    throw new Error(`${fileName}: edge ${index}.risk_flag is invalid.`);
  }

  const sourcePage = value.source_page;
  if (sourcePage !== null && (!Number.isInteger(sourcePage) || (sourcePage as number) < 1)) {
    throw new Error(`${fileName}: edge ${index}.source_page must be a positive integer or null.`);
  }

  const confidence = value.confidence;
  if (confidence !== "high" && confidence !== "medium") {
    throw new Error(`${fileName}: edge ${index}.confidence must be high or medium.`);
  }

  return {
    source: requiredString(value.source, `${fileName}: edge ${index}.source`),
    target: requiredString(value.target, `${fileName}: edge ${index}.target`),
    relation: requiredString(value.relation, `${fileName}: edge ${index}.relation`),
    exposure_pct: exposure as number | null,
    risk_flag: riskFlag,
    source_quote: requiredString(value.source_quote, `${fileName}: edge ${index}.source_quote`),
    source_page: sourcePage as number | null,
    confidence,
  };
}

function parseGraph(value: unknown, fileName: string): StaticGraph {
  if (!isRecord(value)) throw new Error(`${fileName}: graph must be an object.`);
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error(`${fileName}: graph must have nodes and edges arrays.`);
  }

  const nodes = value.nodes.map((node, index) => parseNode(node, fileName, index));
  const edges = value.edges.map((edge, index) => parseEdge(edge, fileName, index));
  if (!Array.isArray(value.key_risks) || value.key_risks.some((risk) => typeof risk !== "string")) {
    throw new Error(`${fileName}: key_risks must be an array of strings.`);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));

  if (nodeIds.size !== nodes.length) throw new Error(`${fileName}: node ids must be unique.`);
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`${fileName}: edge ${edge.source} -> ${edge.target} has an unknown endpoint.`);
    }
  }

  return {
    target_company: requiredString(value.target_company, `${fileName}: target_company`),
    rating: nullableString(value.rating, `${fileName}: rating`),
    report_date: requiredString(value.report_date, `${fileName}: report_date`),
    agency: nullableString(value.agency, `${fileName}: agency`),
    nodes,
    edges,
    key_risks: value.key_risks as string[],
  };
}

/** Stable JSON serialization: object keys sorted, array order preserved. */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("Cannot canonicalize non-finite JSON number.");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
        .join(",")}}`;
    }
    default:
      throw new Error("Cannot canonicalize a non-JSON value.");
  }
}

export function parseReportDate(raw: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) {
    return validatedIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), raw);
  }

  const longForm = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/.exec(raw);
  if (longForm) {
    const month = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ].indexOf(longForm[1]!) + 1;
    return validatedIsoDate(Number(longForm[3]), month, Number(longForm[2]), raw);
  }

  throw new Error(`Unsupported report_date ${JSON.stringify(raw)}. Expected YYYY-MM-DD or Month DD, YYYY.`);
}

function validatedIsoDate(year: number, month: number, day: number, original: string): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid report_date ${JSON.stringify(original)}.`);
  }

  return date.toISOString().slice(0, 10);
}

function filenameToSlug(fileName: string): string {
  return fileName.replace(/\.json$/i, "");
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unnamed";
}

export async function loadStaticGraphFiles(): Promise<StaticGraphFile[]> {
  const fileNames = (await readdir(graphDirectory))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();

  return Promise.all(
    fileNames.map(async (fileName) => {
      const rawFile = await readFile(path.join(graphDirectory, fileName), "utf8");
      let rawJson: unknown;

      try {
        rawJson = JSON.parse(rawFile) as unknown;
      } catch (error) {
        throw new Error(`${fileName}: invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
      }

      return {
        fileName,
        slug: filenameToSlug(fileName),
        hash: createHash("sha256").update(canonicalizeJson(rawJson)).digest("hex"),
        graph: parseGraph(rawJson, fileName),
      };
    }),
  );
}
