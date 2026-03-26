import StorageProvider from "..";

export class ReadOnlyStorachaStorage implements StorageProvider<unknown> {
    async store(_data: unknown): Promise<string> {
        throw new Error("ReadOnlyStorachaStorage cannot store data");
    }

    async retrieve(cid: string): Promise<unknown> {
        const url = `https://${cid}.ipfs.w3s.link`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to retrieve ${cid}: ${response.statusText}`);
        const text = await response.text();
        return JSON.parse(text, (_key, value: unknown) => {
            if (value !== null && typeof value === "object" && "__type" in value && "data" in value &&
                (value as { __type: unknown }).__type === "Uint8Array") {
                return new Uint8Array(Buffer.from((value as { data: string }).data, "base64"));
            }
            return value;
        });
    }

    async delete(_cid: string): Promise<void> {
        throw new Error("ReadOnlyStorachaStorage cannot delete data");
    }
}