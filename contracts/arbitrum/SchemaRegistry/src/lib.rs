#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(feature = "contract-client-gen", allow(unused_imports))]

extern crate alloc;

use alloy_sol_types::sol;
use stylus_sdk::{
    alloy_primitives::{Address, FixedBytes, keccak256, U64},
    prelude::*,
    storage::*,
};

sol! {
    event SchemaRegistered(
        bytes32 indexed id,
        address indexed owner,
        string name,
        string spec_cid,
        string agent_id,
    );

    event SchemaUpdated(
        bytes32 indexed id,
        string new_spec_cid
    );

    error NotOwner();
    error SchemaNotFound();
    error SchemaAlreadyExists();
}

#[derive(SolidityError)]
pub enum RegistryError {
    NotOwner(NotOwner),
    SchemaNotFound(SchemaNotFound),
    SchemaAlreadyExists(SchemaAlreadyExists),
}

#[storage]
pub struct StorageSchema {
    /// Namespaced name e.g. "fangorn.music.v1"
    pub name: StorageString,
    /// IPFS CID of the JSON schema document
    pub spec_cid: StorageString,
    /// Address allowed to publish new spec versions
    pub owner: StorageAddress,
    /// The schema's agent id
    pub agent_id: StorageString
}

#[storage]
#[entrypoint]
pub struct SchemaRegistry {
    /// schema_id => StorageSchema
    schemas: StorageMap<FixedBytes<32>, StorageSchema>,
}

#[public]
impl SchemaRegistry {
    /// Register a new schema. ID is derived from the name so it's deterministic.
    pub fn register_schema(
        &mut self,
        name: String,
        spec_cid: String,
        agent_id: String,
    ) -> Result<FixedBytes<32>, RegistryError> {
        let sender = self.vm().msg_sender();
        let id = schema_id_from_name(name.clone());

        if self.schemas.getter(id).owner.get() != Address::ZERO {
            return Err(RegistryError::SchemaAlreadyExists(SchemaAlreadyExists {}));
        }

        let mut schema = self.schemas.setter(id);
        schema.name.set_str(&name);
        schema.spec_cid.set_str(&spec_cid);
        schema.owner.set(sender);
        schema.agent_id.set_str(&agent_id);

        self.vm().log(SchemaRegistered {
            id,
            owner: sender,
            name,
            spec_cid,
            agent_id,
        });

        Ok(id)
    }

    /// Update the spec CID of an existing schema (owner only).
    pub fn update_schema(
        &mut self,
        name: String,
        new_spec_cid: String,
    ) -> Result<(), RegistryError> {
        let sender = self.vm().msg_sender();
        let id = schema_id_from_name(name);

        let owner = self.schemas.getter(id).owner.get();

        if owner == Address::ZERO {
            return Err(RegistryError::SchemaNotFound(SchemaNotFound {}));
        }

        if owner != sender {
            return Err(RegistryError::NotOwner(NotOwner {}));
        }

        self.schemas.setter(id).spec_cid.set_str(&new_spec_cid);

        self.vm().log(SchemaUpdated { id, new_spec_cid });

        Ok(())
    }

    /// Get the spec CID for a schema by name.
    pub fn get_schema(&self, name: String) -> Result<String, RegistryError> {
        let id = schema_id_from_name(name);
        let schema = self.schemas.getter(id);

        if schema.owner.get() == Address::ZERO {
            return Err(RegistryError::SchemaNotFound(SchemaNotFound {}));
        }

        Ok(schema.spec_cid.get_string())
    }
}

fn schema_id_from_name(name: String) -> FixedBytes<32> {
    use alloy_sol_types::SolValue;
    let encoded = name.abi_encode();
    keccak256(&encoded)
}

// -----------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use alloy_primitives::address;
    use stylus_sdk::testing::*;

    const USER: Address = address!("0xCDC41bff86a62716f050622325CC17a317f99404");
    const OTHER: Address = address!("0xDEADbeefdEAdbeefdEadbEEFdeadbeEFdEADbeeF");

    fn setup() -> (TestVM, DatasourceRegistry) {
        let vm = TestVM::default();
        vm.set_sender(USER);
        let contract = DatasourceRegistry::from(&vm);
        (vm, contract)
    }

    fn test_schema_registration_works() {
        let (_, mut contract) = setup();

        let schema_id = contract
            .register_schema(
                "fangorn.music.v1".to_string(), 
                "bafy...schema".to_string(),
                "agent_id".to_string(),
            )
            .map_err(|_| panic!("there should be no error"))
            .unwrap();
    }

    #[test]
    fn test_schema_update_not_owner_fails() {
        let (vm, mut contract) = setup();

        let _ = contract
            .register_schema(
                "fangorn.music.v1".to_string(), 
                "bafy...schema".to_string(),
                "agent-id".to_string(),
            )
            .map_err(|_| panic!("there should be no error"));

        // not owner
        vm.set_sender(OTHER);
        assert!(contract
            .update_schema("fangorn.music.v1".to_string(), "bafy...new".to_string())
            .is_err());
    }
}