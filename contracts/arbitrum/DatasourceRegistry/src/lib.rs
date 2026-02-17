// ref: https://github.com/OffchainLabs/stylus-sdk-rs/blob/main/examples/call/src/lib.rs
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
    event DataSourceCreated(
        bytes32 indexed id,
        address indexed owner,
        string name
    );

    event DataSourceUpdated(
        bytes32 indexed id,
        string newManifestCid
    );

    error NotOwner();
    error DataSourceNotFound();
    error DataSourceAlreadyExists();
}

#[derive(SolidityError)]
pub enum DatasourceRegistryError {
    // The caller is not the owner
    NotOwner(NotOwner),
    // The datasource does not exist
    DataSourceNotFound(DataSourceNotFound),
    // The datasource already exists
    DataSourceAlreadyExists(DataSourceAlreadyExists),
}

#[storage]
#[entrypoint]
pub struct DatasourceRegistry {
    // owner => datasource ids
    owned: StorageMap<Address, StorageVec<StorageFixedBytes<32>>>,
    // A map of data source name to owner
    data_source_owners: StorageMap<Vec<u8>, StorageAddress>,
    // A map of data source ID to CID, where ID = sha256(name || owner)
    data_source_manifests: StorageMap<Vec<u8>, StorageString>,
}

#[public]
impl DatasourceRegistry {

    /// Register a new named data source
    ///
    /// * `name`: The name of the data source
    ///
    pub fn register_data_source(
        &mut self,
        name: String,
        // agent_id: ... future
    ) -> Result<FixedBytes<32>, DatasourceRegistryError> {
        // get sender and compute datasource id
        let sender = self.vm().msg_sender();
        let id = hash_concat(name.as_bytes(), sender.as_slice());
        // if we already registered the named datasource then reject the call
        let existing_owner = self.data_source_owners.get(id.to_vec());
        if existing_owner != Address::ZERO {
            return Err(DatasourceRegistryError::DataSourceAlreadyExists(
                DataSourceAlreadyExists {},
            ));
        }
        // TODO: erc-8004 identity registry here (later)
        // update storage
        self.data_source_manifests.setter(id.to_vec()).set_str("");
        self.owned.setter(sender).push(id);
        self.vm().log(DataSourceCreated {
            id,
            owner: sender,
            name,
        });
        Ok(id)
    }

    pub fn update_data_source(
        &mut self,
        name: String,
        new_manifest_cid: String,
    ) -> Result<(), DatasourceRegistryError> {
        let sender = self.vm().msg_sender();
        let id = hash_concat(name.as_bytes(), sender.as_slice());
        let owner = self.data_source_owners.get(id.to_vec());
        // reject if caller does not own the datasource
        if owner == Address::ZERO {
            return Err(DatasourceRegistryError::DataSourceNotFound(DataSourceNotFound {}));
        }
        if owner != self.vm().msg_sender() {
            return Err(DatasourceRegistryError::NotOwner(NotOwner {}));
        }
        self.data_source_manifests.setter(id.to_vec()).set_str(&new_manifest_cid);
        self.vm().log(DataSourceUpdated {
            id,
            newManifestCid: new_manifest_cid,
        });
        Ok(())
    }

    pub fn get_data_source(
        &self, 
        owner: Address, 
        name: String
    ) -> Result<(FixedBytes<32>, String), DatasourceRegistryError> {
        let id = hash_concat(name.as_bytes(), owner.as_ref());
        if self.data_source_owners.get(id.to_vec()) == Address::ZERO {
            return Err(DatasourceRegistryError::DataSourceNotFound(DataSourceNotFound {}));
        }
        Ok((id, self.data_source_manifests.getter(id.to_vec()).get_string()))
    }

    pub fn get_owned_data_sources(&self, owner: Address) -> Vec<FixedBytes<32>> {
        let owned_vec = self.owned.getter(owner);
        (0..owned_vec.len()).filter_map(|i| owned_vec.get(i)).collect()
    }
}

// helper funcs
fn hash_concat(a: &[u8], b: &[u8]) -> FixedBytes<32> {
    let mut data = Vec::with_capacity(a.len() + b.len());
    data.extend_from_slice(a);
    data.extend_from_slice(b);
    keccak256(&data)
}