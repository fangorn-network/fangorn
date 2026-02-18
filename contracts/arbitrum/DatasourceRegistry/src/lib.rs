#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(feature = "contract-client-gen", allow(unused_imports))]

extern crate alloc;

use alloy_sol_types::sol;
use stylus_sdk::{
    alloy_primitives::{Address, FixedBytes, keccak256},
    abi::AbiType,
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
    NotOwner(NotOwner),
    DataSourceNotFound(DataSourceNotFound),
    DataSourceAlreadyExists(DataSourceAlreadyExists),
}

// Mirrors the Solidity DataSource struct in storage
#[storage]
pub struct StorageDataSource {
    pub name: StorageString,
    pub manifest_cid: StorageString,
    pub owner: StorageAddress,
}

#[storage]
#[entrypoint]
pub struct DatasourceRegistry {
    // owner => datasource ids
    owned: StorageMap<Address, StorageVec<StorageFixedBytes<32>>>,
    // id => DataSource struct
    data_sources: StorageMap<FixedBytes<32>, StorageDataSource>,
}

#[public]
impl DatasourceRegistry {

    pub fn register_data_source(
        &mut self,
        name: String,
    ) -> Result<FixedBytes<32>, DatasourceRegistryError> {
        let sender = self.vm().msg_sender();
        let id = abi_encode_id(name.clone(), sender);

        // reject if already registered
        if self.data_sources.getter(id).owner.get() != Address::ZERO {
            return Err(DatasourceRegistryError::DataSourceAlreadyExists(
                DataSourceAlreadyExists {},
            ));
        }

        // store struct fields
        let mut ds = self.data_sources.setter(id);
        ds.name.set_str(&name);
        ds.manifest_cid.set_str("");
        ds.owner.set(sender);

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
        let id = abi_encode_id(name.clone(), sender);

        let owner = self.data_sources.getter(id).owner.get();
        if owner == Address::ZERO {
            return Err(DatasourceRegistryError::DataSourceNotFound(DataSourceNotFound {}));
        }
        if owner != sender {
            return Err(DatasourceRegistryError::NotOwner(NotOwner {}));
        }

        self.data_sources.setter(id).manifest_cid.set_str(&new_manifest_cid);

        self.vm().log(DataSourceUpdated {
            id,
            newManifestCid: new_manifest_cid,
        });

        Ok(())
    }

    pub fn get_data_source(
        &self,
        owner: Address,
        name: String,
    ) -> Result<String, DatasourceRegistryError> {
        let id = abi_encode_id(name.clone(), owner);

        if self.data_sources.getter(id).owner.get() == Address::ZERO {
            return Err(DatasourceRegistryError::DataSourceNotFound(DataSourceNotFound {}));
        }

        Ok(self.data_sources.getter(id).manifest_cid.get_string())
    }

    pub fn get_owned_data_sources(&self, owner: Address) -> Vec<FixedBytes<32>> {
        let owned_vec = self.owned.getter(owner);
        (0..owned_vec.len()).filter_map(|i| owned_vec.get(i)).collect()
    }
}

fn abi_encode_id(name: String, owner: Address) -> FixedBytes<32> {
    use alloy_sol_types::{SolValue};
    let encoded = (name, owner).abi_encode();
    keccak256(&encoded)
}

// fn abi_encode_id(name: &[u8], owner: Address) -> FixedBytes<32> {
//     // Replicates keccak256(abi.encode(name, msg.sender))
//     // abi.encode(string, address) layout:
//     //   [0..32]  offset to string data = 0x40 (64)
//     //   [32..64] address, right-padded to 32 bytes
//     //   [64..96] string length
//     //   [96..]   string bytes, padded to 32-byte boundary
    
//     let mut buf = Vec::new();

//     // offset for the string (points past the two head slots = 64)
//     let mut offset = [0u8; 32];
//     offset[31] = 64;
//     buf.extend_from_slice(&offset);

//     // address padded to 32 bytes (left-padded with zeros)
//     let mut addr_padded = [0u8; 32];
//     addr_padded[12..].copy_from_slice(owner.as_slice());
//     buf.extend_from_slice(&addr_padded);

//     // string length as uint256
//     let mut len_padded = [0u8; 32];
//     let name_len = name.len();
//     len_padded[24..].copy_from_slice(&(name_len as u64).to_be_bytes());
//     buf.extend_from_slice(&len_padded);

//     // string bytes padded to 32-byte boundary
//     buf.extend_from_slice(name);
//     let remainder = name_len % 32;
//     if remainder != 0 {
//         buf.extend(core::iter::repeat(0u8).take(32 - remainder));
//     }

//     keccak256(&buf)
// }