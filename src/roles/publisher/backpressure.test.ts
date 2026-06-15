import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { PublisherRole } from "./index.js";
import type { PublishRecord } from "./types.js";

/**
 * Regression guard for the streaming-publish memory fix.
 *
 * publish() must apply backpressure: the source record generator may only run
 * a bounded number of chunks ahead of in-flight uploads, so peak memory is
 * proportional to `concurrency`, not to the total dataset size. Before the fix
 * the loop drained the entire generator up front, pinning every chunk.
 */
describe("PublisherRole.publish backpressure", () => {
    it("bounds generation by upload concurrency and builds a correct manifest", async () => {
        const TOTAL = 20_000;
        const CHUNK_SIZE = 1000;
        const CONCURRENCY = 4;

        let produced = 0;
        let inFlight = 0;
        let maxInFlight = 0;
        let completedUploads = 0;
        let maxLeadChunks = 0;

        // Must be an async generator to satisfy AsyncIterable<PublishRecord>; the
        // lazy yield is what lets the test measure backpressure, not the awaiting.
        // eslint-disable-next-line @typescript-eslint/require-await
        async function* source(): AsyncIterable<PublishRecord> {
            for (let i = 0; i < TOTAL; i++) {
                produced++;
                yield { name: `rec-${i.toString()}`, fields: { x: i.toString() } };
            }
        }

        const storage = {
            async put(): Promise<string> {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                maxLeadChunks = Math.max(
                    maxLeadChunks,
                    Math.ceil(produced / CHUNK_SIZE) - completedUploads,
                );
                await new Promise((r) => setTimeout(r, 2));
                inFlight--;
                completedUploads++;
                return `cid-${completedUploads.toString()}-${Math.random().toString(36).slice(2, 8)}`;
            },

            get(): unknown {
                return { definition: { x: { "@type": "string" } } };
            },
        };

        const schemaRegistry = {
            getSchema() {
                return { specCid: "spec-cid" };
            },

            schemaId(): Hex {
                return "0x1234567890123456789012345678901234567890123456789012345678901234";
            },
        };
        const dataSourceRegistry = {
            publish() {
                return undefined;
            },
        };
        const walletClient = {
            account: { address: "0x00000000000000000000000000000000000000aa" as Hex },
        };

        const publisher = new PublisherRole(
            dataSourceRegistry as never,
            schemaRegistry as never,
            storage as never,
            walletClient as never,
            {} as never,
        );

        const result = await publisher.publishRecords({
            records: source(),
            schemaName: "demo",
            datasetName: "ds.verify",
            chunkSize: CHUNK_SIZE,
            concurrency: CONCURRENCY,
        });

        const expectedChunks = Math.ceil(TOTAL / CHUNK_SIZE);
        expect(result.entryCount).toBe(expectedChunks);
        // never more than `concurrency` uploads at once
        expect(maxInFlight).toBeLessThanOrEqual(CONCURRENCY);
        // generation stays within a small constant of completed uploads (not the whole dataset)
        expect(maxLeadChunks).toBeLessThanOrEqual(CONCURRENCY + 2);
        expect(maxLeadChunks).toBeLessThan(expectedChunks);
    });
});
