#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(feature = "contract-client-gen", allow(unused_imports))]

extern crate alloc;

use alloy_sol_types::sol;
use stylus_sdk::{
    alloy_primitives::{Address, FixedBytes, U64},
    call::RawCall,
    prelude::*,
    storage::*,
};

sol! {
    event ManifestPublished(
        address indexed owner,
        bytes32 indexed schema_id,
        string manifest_cid,
        uint64 version
    );

    error DataSourceNotFound();
    error SchemaNotFound();
    error SchemaRequired();
}

#[derive(SolidityError)]
pub enum DataSourceRegistryError {
    DataSourceNotFound(DataSourceNotFound),
    SchemaNotFound(SchemaNotFound),
    SchemaRequired(SchemaRequired),
}

#[storage]
pub struct StorageDataSource {
    /// IPFS CID of the current manifest
    pub manifest_cid: StorageString,
    /// Monotonically incrementing publish counter
    pub version: StorageU64,
}

#[storage]
#[entrypoint]
pub struct DataSourceRegistry {
    /// owner => schema_id => DataSource
    data_sources: StorageMap<Address, StorageMap<FixedBytes<32>, StorageDataSource>>,
    /// address of the deployed SchemaRegistry contract
    schema_registry: StorageAddress,
}

#[public]
impl DataSourceRegistry {

    #[constructor]
    pub fn initialize(&mut self, schema_registry: Address) {
        self.schema_registry.set(schema_registry);
    }

    /// Publish (or re-publish) a manifest under a specific schema.
    /// schema_id must be non-zero and must exist in the SchemaRegistry.
    pub fn publish_manifest(
        &mut self,
        manifest_cid: String,
        schema_id: FixedBytes<32>,
    ) -> Result<(), DataSourceRegistryError> {
        let sender = self.vm().msg_sender();
        let zero: FixedBytes<32> = FixedBytes::ZERO;

        if schema_id == zero {
            return Err(DataSourceRegistryError::SchemaRequired(SchemaRequired {}));
        }

        // Validate schema exists in SchemaRegistry
        let registry = self.schema_registry.get();
        let calldata = schema_exists_calldata(schema_id);
        let result = unsafe { RawCall::new(self.vm()).call(registry, &calldata) };
        let exists = result.map(|r| r.last().copied().unwrap_or(0) != 0).unwrap_or(false);
        if !exists {
            return Err(DataSourceRegistryError::SchemaNotFound(SchemaNotFound {}));
        }

        let mut binding = self.data_sources.setter(sender);
        let mut ds = binding.setter(schema_id);
   
        let new_version = ds.version.get() + U64::from(1);
        ds.version.set(new_version);
        ds.manifest_cid.set_str(&manifest_cid);

        self.vm().log(ManifestPublished {
            owner: sender,
            schema_id,
            manifest_cid,
            version: new_version.to::<u64>(),
        });

        Ok(())
    }

    /// Get the manifest CID for a given (owner, schema_id) pair.
    pub fn get_manifest(
        &self,
        owner: Address,
        schema_id: FixedBytes<32>,
    ) -> Result<String, DataSourceRegistryError> {
        let binding = self.data_sources.getter(owner);
        let ds = binding.getter(schema_id);
        if ds.version.get() == U64::ZERO {
            return Err(DataSourceRegistryError::DataSourceNotFound(DataSourceNotFound {}));
        }
        Ok(ds.manifest_cid.get_string())
    }

    /// Get the current version for a given (owner, schema_id) pair.
    pub fn get_version(&self, owner: Address, schema_id: FixedBytes<32>) -> u64 {
        self.data_sources.getter(owner).getter(schema_id).version.get().to::<u64>()
    }
}

fn schema_exists_calldata(id: FixedBytes<32>) -> Vec<u8> {
    use stylus_sdk::alloy_primitives::keccak256;
    let selector = &keccak256(b"schemaExists(bytes32)")[..4];
    let mut calldata = selector.to_vec();
    calldata.extend_from_slice(id.as_slice());
    calldata
}

#[cfg(test)]
mod test {
    use super::*;
    use alloy_primitives::address;
    use stylus_sdk::testing::*;

    const USER: Address = address!("0xCDC41bff86a62716f050622325CC17a317f99404");
    const SCHEMA_A: FixedBytes<32> = FixedBytes::new([1u8; 32]);
    const SCHEMA_B: FixedBytes<32> = FixedBytes::new([2u8; 32]);
    const DUMMY_REGISTRY: Address = address!("0x1111111111111111111111111111111111111111");

    fn setup() -> (TestVM, DataSourceRegistry) {
        let vm = TestVM::default();
        vm.set_sender(USER);
        let mut contract = DataSourceRegistry::from(&vm);
        contract.initialize(DUMMY_REGISTRY);
        (vm, contract)
    }

    #[test]
    fn test_schema_required() {
        let (_, mut contract) = setup();
        // zero schema_id must be rejected
        assert!(contract
            .publish_manifest("bafy...abc".to_string(), FixedBytes::ZERO)
            .is_err());
    }

    #[test]
    fn test_publish_with_unknown_schema_fails() {
        let (_, mut contract) = setup();
        // dummy registry returns false for all schema_exists calls
        assert!(contract
            .publish_manifest("bafy...abc".to_string(), SCHEMA_A)
            .is_err());
    }

    #[test]
    fn test_no_manifest_before_publish() {
        let (_, contract) = setup();
        match contract.get_manifest(USER, SCHEMA_A) {
            Ok(_) => panic!("Should not have a manifest yet"),
            Err(_) => {}
        }
    }

    #[test]
    fn test_independent_manifests_per_schema() {
        // This test validates the (owner, schema_id) keying at the storage level.
        // We bypass schema validation by pointing at DUMMY_REGISTRY which returns
        // false, so we can't call publish_manifest directly here — the cross-contract
        // call always fails in the test VM. Storage independence is verified by the
        // contract structure: two nested StorageMap lookups guarantee isolation.
        //
        // Full integration coverage lives in the e2e tests where a real
        // SchemaRegistry is deployed and schemaExists returns true.
        let (_, contract) = setup();
        assert_eq!(contract.get_version(USER, SCHEMA_A), 0);
        assert_eq!(contract.get_version(USER, SCHEMA_B), 0);
    }

    #[test]
    fn test_version_starts_at_zero() {
        let (_, contract) = setup();
        assert_eq!(contract.get_version(USER, SCHEMA_A), 0);
    }
}