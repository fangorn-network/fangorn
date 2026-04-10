// abi.ts
export const DS_REGISTRY_ABI = [
    {"inputs":[],"name":"DataSourceNotFound","type":"error"},
    {"inputs":[],"name":"NameRequired","type":"error"},
    {"inputs":[],"name":"ResourceSetupFailed","type":"error"},
    {"inputs":[],"name":"SchemaNotFound","type":"error"},
    {"inputs":[],"name":"SchemaRequired","type":"error"},
    {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"bytes32","name":"schema_id","type":"bytes32"},{"internalType":"string","name":"name","type":"string"}],"name":"get","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"bytes32","name":"schema_id","type":"bytes32"},{"internalType":"bytes32","name":"name_hash","type":"bytes32"}],"name":"getByHash","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"bytes32","name":"schema_id","type":"bytes32"},{"internalType":"bytes32","name":"name_hash","type":"bytes32"}],"name":"getName","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"bytes32","name":"schema_id","type":"bytes32"},{"internalType":"string","name":"name","type":"string"}],"name":"getVersion","outputs":[{"internalType":"uint64","name":"","type":"uint64"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"string","name":"manifest_cid","type":"string"},{"internalType":"bytes32","name":"schema_id","type":"bytes32"},{"internalType":"string","name":"name","type":"string"},{"internalType":"uint256","name":"price","type":"uint256"}],"name":"publish","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"bytes32","name":"schema_id","type":"bytes32"},{"internalType":"string","name":"name","type":"string"}],"name":"resourceId","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"}
] as const;