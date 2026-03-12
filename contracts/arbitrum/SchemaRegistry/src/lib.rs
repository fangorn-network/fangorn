#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(feature = "contract-client-gen", allow(unused_imports))]

extern crate alloc;

use alloy_sol_types::sol;
use stylus_sdk::{
    alloy_primitives::{Address, FixedBytes, keccak256},
    prelude::*,
    storage::*,
};

sol! {
    event SchemaRegistered(
        bytes32 indexed id,
        address indexed owner,
        string name,
        string spec_cid,
        string agent_id
    );

    event SchemaUpdated(
        bytes32 indexed id,
        string new_spec_cid,
        string new_agent_id
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
    pub name: StorageString,
    pub spec_cid: StorageString,
    pub agent_id: StorageString,
    pub owner: StorageAddress,
}

#[storage]
#[entrypoint]
pub struct SchemaRegistry {
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
        schema.agent_id.set_str(&agent_id);
        schema.owner.set(sender);

        self.vm().log(SchemaRegistered { id, owner: sender, name, spec_cid, agent_id });

        Ok(id)
    }

    /// Update the spec CID and agent ID of an existing schema (owner only).
    pub fn update_schema(
        &mut self,
        name: String,
        new_spec_cid: String,
        new_agent_id: String,
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

        let mut schema = self.schemas.setter(id);
        schema.spec_cid.set_str(&new_spec_cid);
        schema.agent_id.set_str(&new_agent_id);

        self.vm().log(SchemaUpdated { id, new_spec_cid, new_agent_id });

        Ok(())
    }

    /// Get the spec CID for a schema by name.
    pub fn get_schema_spec(&self, name: String) -> Result<String, RegistryError> {
        let id = schema_id_from_name(name);
        if self.schemas.getter(id).owner.get() == Address::ZERO {
            return Err(RegistryError::SchemaNotFound(SchemaNotFound {}));
        }
        Ok(self.schemas.getter(id).spec_cid.get_string())
    }

    /// Get the agent ID for a schema by name.
    pub fn get_schema_agent(&self, name: String) -> Result<String, RegistryError> {
        let id = schema_id_from_name(name);
        if self.schemas.getter(id).owner.get() == Address::ZERO {
            return Err(RegistryError::SchemaNotFound(SchemaNotFound {}));
        }
        Ok(self.schemas.getter(id).agent_id.get_string())
    }

    /// Check whether a schema exists by its bytes32 id (used by DataSourceRegistry).
    pub fn schema_exists(&self, id: FixedBytes<32>) -> bool {
        self.schemas.getter(id).owner.get() != Address::ZERO
    }
}

pub fn schema_id_from_name(name: String) -> FixedBytes<32> {
    use alloy_sol_types::SolValue;
    keccak256(name.abi_encode())
}
#[cfg(test)]
mod test {
    use super::*;
    use alloy_primitives::address;
    use stylus_sdk::testing::*;

    const USER: Address = address!("0xCDC41bff86a62716f050622325CC17a317f99404");
    const OTHER: Address = address!("0xDEADbeefdEAdbeefdEadbEEFdeadbeEFdEADbeeF");

    fn setup() -> (TestVM, SchemaRegistry) {
        let vm = TestVM::default();
        vm.set_sender(USER);
        let contract = SchemaRegistry::from(&vm);
        (vm, contract)
    }

    #[test]
    fn test_schema_registration_works() {
        let (_, mut contract) = setup();

        match contract.register_schema(
            "fangorn.music.v1".to_string(),
            "bafy...schema".to_string(),
            "agent_id".to_string(),
        ) {
            Ok(id) => {
                assert!(contract.schema_exists(id));
                match contract.get_schema_spec("fangorn.music.v1".to_string()) {
                    Ok(spec) => assert_eq!(spec, "bafy...schema"),
                    Err(_) => panic!("get_schema_spec should not fail"),
                }
                match contract.get_schema_agent("fangorn.music.v1".to_string()) {
                    Ok(agent) => assert_eq!(agent, "agent_id"),
                    Err(_) => panic!("get_schema_agent should not fail"),
                }
            }
            Err(_) => panic!("register_schema should not fail"),
        }
    }

    #[test]
    fn test_duplicate_schema_fails() {
        let (_, mut contract) = setup();

        match contract.register_schema(
            "fangorn.music.v1".to_string(),
            "bafy...schema".to_string(),
            "agent_id".to_string(),
        ) {
            Ok(_) => {
                assert!(contract
                    .register_schema(
                        "fangorn.music.v1".to_string(),
                        "bafy...schema2".to_string(),
                        "agent_id2".to_string(),
                    )
                    .is_err());
            }
            Err(_) => panic!("first register_schema should not fail"),
        }
    }

    #[test]
    fn test_schema_update_not_owner_fails() {
        let (vm, mut contract) = setup();

        match contract.register_schema(
            "fangorn.music.v1".to_string(),
            "bafy...schema".to_string(),
            "agent-id".to_string(),
        ) {
            Ok(_) => {
                vm.set_sender(OTHER);
                assert!(contract
                    .update_schema(
                        "fangorn.music.v1".to_string(),
                        "bafy...new".to_string(),
                        "agent-new".to_string(),
                    )
                    .is_err());
            }
            Err(_) => panic!("register_schema should not fail"),
        }
    }

    #[test]
    fn test_schema_update_owner_succeeds() {
        let (_, mut contract) = setup();

        match contract.register_schema(
            "fangorn.music.v1".to_string(),
            "bafy...schema".to_string(),
            "agent-id".to_string(),
        ) {
            Ok(_) => {
                match contract.update_schema(
                    "fangorn.music.v1".to_string(),
                    "bafy...new".to_string(),
                    "agent-new".to_string(),
                ) {
                    Ok(_) => {
                        match contract.get_schema_spec("fangorn.music.v1".to_string()) {
                            Ok(spec) => assert_eq!(spec, "bafy...new"),
                            Err(_) => panic!("get_schema_spec should not fail"),
                        }
                        match contract.get_schema_agent("fangorn.music.v1".to_string()) {
                            Ok(agent) => assert_eq!(agent, "agent-new"),
                            Err(_) => panic!("get_schema_agent should not fail"),
                        }
                    }
                    Err(_) => panic!("update_schema should not fail"),
                }
            }
            Err(_) => panic!("register_schema should not fail"),
        }
    }
}