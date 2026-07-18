import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { graphDataSchema, sandboxGraphSchema, type GraphData } from "@/lib/graph-data";

export const runtime = "nodejs";

const companyDirectory = path.join(process.cwd(), "data", "companies");

function developmentOnlyResponse() {
  if (process.env.NODE_ENV === "development") return null;
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

function slugForCompany(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 96);
}

function sandboxItem(id: string, graph: GraphData) {
  return {
    id,
    name: graph.target_company,
    agency: graph.agency,
    graph,
  };
}

export async function GET() {
  const unavailable = developmentOnlyResponse();
  if (unavailable) return unavailable;

  try {
    const files = (await fs.readdir(companyDirectory)).filter((file) => file.endsWith(".json")).sort();
    const companies = (
      await Promise.all(
        files.map(async (file) => {
          try {
            const raw = JSON.parse(await fs.readFile(path.join(companyDirectory, file), "utf8"));
            const parsed = sandboxGraphSchema.safeParse(raw);
            if (!parsed.success || !parsed.data.verified) return null;
            const { verified: _verified, ...graph } = parsed.data;
            return sandboxItem(path.basename(file, ".json"), graph);
          } catch {
            return null;
          }
        }),
      )
    )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => left.name.localeCompare(right.name));

    return NextResponse.json({ companies });
  } catch {
    return NextResponse.json({ error: "Unable to read the local sandbox." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const unavailable = developmentOnlyResponse();
  if (unavailable) return unavailable;

  try {
    const payload: unknown = await request.json();
    const candidate = typeof payload === "object" && payload && "graph" in payload ? payload.graph : null;
    const parsed = graphDataSchema.safeParse(candidate);
    if (!parsed.success) {
      return NextResponse.json({ error: "The live graph is not valid sandbox data." }, { status: 400 });
    }

    const id = slugForCompany(parsed.data.target_company);
    if (!id) return NextResponse.json({ error: "Unable to derive a safe sandbox filename." }, { status: 400 });

    const destination = path.resolve(companyDirectory, `${id}.json`);
    if (path.dirname(destination) !== companyDirectory) {
      return NextResponse.json({ error: "Unable to derive a safe sandbox filename." }, { status: 400 });
    }

    let overwritingUnverifiedEntry = false;
    try {
      const existing = sandboxGraphSchema.safeParse(JSON.parse(await fs.readFile(destination, "utf8")));
      if (!existing.success) {
        return NextResponse.json({ error: "An existing sandbox file could not be validated. It was not overwritten." }, { status: 409 });
      }
      if (existing.data.verified) {
        return NextResponse.json({ error: "This sandbox entry is verified and cannot be overwritten." }, { status: 409 });
      }
      overwritingUnverifiedEntry = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The file does not exist, so creating it is safe.
    }

    await fs.writeFile(destination, `${JSON.stringify({ ...parsed.data, verified: false }, null, 2)}\n`, "utf8");
    return NextResponse.json({ id, verified: false, overwritten: overwritingUnverifiedEntry }, { status: overwritingUnverifiedEntry ? 200 : 201 });
  } catch {
    return NextResponse.json({ error: "Unable to save this graph to the local sandbox." }, { status: 500 });
  }
}
