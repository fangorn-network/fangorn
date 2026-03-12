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
        string manifest_cid,
        uint64 version,
        bytes32 indexed schema_id
    );

    error DataSourceNotFound();
    error SchemaNotFound();
}

#[derive(SolidityError)]
pub enum DataSourceRegistryError {
    DataSourceNotFound(DataSourceNotFound),
    SchemaNotFound(SchemaNotFound),
}

#[storage]
pub struct StorageDataSource {
    /// IPFS CID of the current manifest
    pub manifest_cid: StorageString,
    /// Schema this data source conforms to (zero = untyped)
    pub schema_id: StorageFixedBytes<32>,
    /// Monotonically incrementing publish counter
    pub version: StorageU64,
}

#[storage]
#[entrypoint]
pub struct DataSourceRegistry {
    /// one data source per owner address
    data_sources: StorageMap<Address, StorageDataSource>,
    /// address of the deployed SchemaRegistry contract
    schema_registry: StorageAddress,
}

#[public]
impl DataSourceRegistry {

    /// Set the SchemaRegistry contract address (called once on deploy).
    pub fn initialize(&mut self, schema_registry: Address) {
        // only set if not already initialized
        if self.schema_registry.get() == Address::ZERO {
            self.schema_registry.set(schema_registry);
        }
    }

    /// Publish (or re-publish) the caller's manifest.
    /// Pass `schema_id` as zero bytes to leave schema unset/unchanged.
    pub fn publish_manifest(
        &mut self,
        manifest_cid: String,
        schema_id: FixedBytes<32>,
    ) -> Result<(), DataSourceRegistryError> {
        let sender = self.vm().msg_sender();
        let zero: FixedBytes<32> = FixedBytes::ZERO;

        // Validate schema exists if one is being set
        if schema_id != zero {
            let registry = self.schema_registry.get();
            let calldata = schema_exists_calldata(schema_id);
            let result = unsafe { RawCall::new(self.vm()).call(registry, &calldata) };
            let exists = result.map(|r| r.first().copied().unwrap_or(0) != 0).unwrap_or(false);
            if !exists {
                return Err(DataSourceRegistryError::SchemaNotFound(SchemaNotFound {}));
            }
        }

        let mut ds = self.data_sources.setter(sender);
        
        let new_version = ds.version.get() + U64::from(1);
        ds.version.set(new_version);
        ds.manifest_cid.set_str(&manifest_cid);

        if schema_id != zero {
            ds.schema_id.set(schema_id);
        }

        let effective_schema_id = self.data_sources.getter(sender).schema_id.get();

        self.vm().log(ManifestPublished {
            owner: sender,
            manifest_cid,
            version: new_version.to::<u64>(),
            schema_id: effective_schema_id,
        });

        Ok(())
    }

    pub fn get_manifest(&self, owner: Address) -> Result<String, DataSourceRegistryError> {
        let ds = self.data_sources.getter(owner);
        if ds.version.get() == U64::ZERO {
            return Err(DataSourceRegistryError::DataSourceNotFound(DataSourceNotFound {}));
        }
        Ok(ds.manifest_cid.get_string())
    }

    pub fn get_version(&self, owner: Address) -> u64 {
        self.data_sources.getter(owner).version.get().to::<u64>()
    }

    pub fn get_schema_id(&self, owner: Address) -> FixedBytes<32> {
        self.data_sources.getter(owner).schema_id.get()
    }
}

/// Encode a call to `schema_exists(bytes32)` — selector = keccak256("schema_exists(bytes32)")[..4]
fn schema_exists_calldata(id: FixedBytes<32>) -> Vec<u8> {
    use stylus_sdk::alloy_primitives::keccak256;
    let selector = &keccak256(b"schema_exists(bytes32)")[..4];
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

    fn setup() -> (TestVM, DataSourceRegistry) {
        let vm = TestVM::default();
        vm.set_sender(USER);
        let contract = DataSourceRegistry::from(&vm);
        (vm, contract)
    }

    #[test]
    fn test_publish_untyped_manifest() {
        let (_, mut contract) = setup();

        assert!(contract.get_manifest(USER).is_err());

        let res = contract.publish_manifest("bafy...abc".to_string(), FixedBytes::ZERO);
        assert!(res.is_ok());

        match contract.get_manifest(USER) {
            Ok(manifest) => {
                assert!(manifest.eq(&"bafy...abc"));
                assert_eq!(contract.get_version(USER), 1);
            },
            Err(_e) => {
                panic!("There should be no error.");
            }
        }
    }

    #[test]
    fn test_publish_increments_version() {
        let (_, mut contract) = setup();

        let res = contract.publish_manifest("bafy...v1".to_string(), FixedBytes::ZERO);
        assert!(res.is_ok());

        let res = contract.publish_manifest("bafy...v2".to_string(), FixedBytes::ZERO);
        assert!(res.is_ok());

        assert_eq!(contract.get_version(USER), 2);
        
        match contract.get_manifest(USER) {
            Ok(manifest) => {
                assert!(manifest.eq(&"bafy...v2"));
            },
            Err(_e) => {
                panic!("There should be no error.");
            }
        }
    }

    #[test]
    fn test_publish_with_unknown_schema_fails() {
        let (vm, mut contract) = setup();

        // point at a dummy registry that will return false for schema_exists
        let dummy_registry = address!("0x1111111111111111111111111111111111111111");
        vm.set_sender(USER); // ensure initialize caller
        contract.initialize(dummy_registry);

        let fake_id = FixedBytes::from([1u8; 32]);
        assert!(contract.publish_manifest("bafy...manifest".to_string(), fake_id).is_err());
    }
}