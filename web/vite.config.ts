import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE_CALIBRATION_SCHEMA = "bronchoedu_scope_calibration/v1";
const scopeCalibrationPath = fileURLToPath(new URL("./public/cases/default/scope_calibration.json", import.meta.url));

export default defineConfig({
  plugins: [react(), scopeCalibrationWriter()],
  server: {
    fs: {
      strict: true
    }
  }
});

function scopeCalibrationWriter() {
  return {
    name: "scope-calibration-writer",
    configureServer(server) {
      server.middlewares.use("/__scope_calibration", async (request, response) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("method not allowed");
          return;
        }

        try {
          const body = await readJsonBody(request);
          const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
          if (!/^\d+$/.test(nodeId)) {
            response.statusCode = 400;
            response.end("nodeId must be a numeric string");
            return;
          }

          const payload = await readScopeCalibration();
          payload.caseId = typeof body.caseId === "string" ? body.caseId : payload.caseId;
          payload.updatedAt = new Date().toISOString();
          if (body.adjustment === null) {
            delete payload.adjustments[nodeId];
          } else if (isRecord(body.adjustment)) {
            payload.adjustments[nodeId] = body.adjustment;
          } else {
            response.statusCode = 400;
            response.end("adjustment must be an object or null");
            return;
          }

          await mkdir(dirname(scopeCalibrationPath), { recursive: true });
          await writeFile(scopeCalibrationPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, path: "/cases/default/scope_calibration.json" }));
        } catch (error) {
          response.statusCode = 500;
          response.end(error instanceof Error ? error.message : String(error));
        }
      });
    }
  };
}

async function readScopeCalibration() {
  try {
    const parsed = JSON.parse(await readFile(scopeCalibrationPath, "utf8"));
    if (isRecord(parsed) && isRecord(parsed.adjustments)) {
      return {
        ...parsed,
        schema: SCOPE_CALIBRATION_SCHEMA,
        adjustments: parsed.adjustments
      };
    }
  } catch {
    // Fall through to a fresh calibration file.
  }
  return {
    schema: SCOPE_CALIBRATION_SCHEMA,
    caseId: "synthetic-target",
    adjustments: {}
  };
}

function readJsonBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw || "{}");
        resolve(isRecord(parsed) ? parsed : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
