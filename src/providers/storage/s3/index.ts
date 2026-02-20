// class S3Storage implements StorageProvider {
//   constructor(private s3: S3Client, private bucket: string) {}

//   async store(data: Uint8Array) {
//     const key = crypto.randomUUID();
//     await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
//     return key;
//   }

//   async retrieve(key: string) {
//     const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
//     return new Uint8Array(await response.Body!.transformToByteArray());
//   }
// }
