// ref: https://github.com/OffchainLabs/stylus-sdk-rs/blob/main/examples/call/src/lib.rs
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(feature = "contract-client-gen", allow(unused_imports))]

extern crate alloc;

use alloy_sol_types::sol;
use stylus_sdk::{
    alloy_primitives::{Address, FixedBytes, keccak256, U256},
    prelude::*, 
    storage::*,
};

sol_interface! {
    // interface for submitting transferWithAuth calls (ERC-3009)
    interface IUSDC {
        function transferWithAuthorization(
            address from,
            address to,
            uint256 value,
            uint256 valid_after,
            uint256 valid_before,
            bytes32 nonce,
            uint8 v,
            bytes32 r,
            bytes32 s
        ) external;
    }
}

sol! {
    event SettlementRecorded(
        bytes32 indexed hash,
        uint256 amount,
    );

    error AlreadyPaid();
    error TransferFailed();
}

#[derive(SolidityError)]
pub enum SettlementTrackerError {
    // The payment has already been settled
    AlreadyPaid(AlreadyPaid),
    // The payment failed
    TransferFailed(TransferFailed),
}

#[storage]
#[entrypoint]
pub struct SettlementTracker {
    // the usdc contract address
    usdc_address: StorageAddress,
    // map hash(owner_addr + name + tag + buyer_addr) => accessibility status
    settlement_tracker: StorageMap<FixedBytes<32>, StorageBool>,
}

#[public]
impl SettlementTracker {

    #[constructor]
    pub fn init(&mut self, usdc_address: Address) {
        self.usdc_address.set(usdc_address);
    }

    // submit the transferWithAuthorization payment
    #[payable]
    pub fn pay(
        &mut self, 
        commitment: FixedBytes<32>, 
        from: Address, 
        to: Address, 
        amount: U256, 
        valid_after: U256, 
        valid_before: U256, 
        nonce: FixedBytes<32>, 
        v: u8, 
        r: FixedBytes<32>, 
        s: FixedBytes<32>
    ) -> Result<(), SettlementTrackerError> {
        let hash = hash_concat(commitment.as_slice(), from.as_slice());
        if !self.settlement_tracker.get(hash) {
            let usdc_address = self.usdc_address.get();
            let usdc = IUSDC::new(usdc_address);
            let config = Call::new_mutating(self);        
            let result = usdc.transfer_with_authorization(
                self.vm(), config, from, to, amount, valid_after, valid_before, nonce, v, r, s);
            if result.is_err() {
                return Err(SettlementTrackerError::TransferFailed(TransferFailed {}));
            }
            self.settlement_tracker.setter(hash).set(true);          
            self.vm().log(SettlementRecorded { hash, amount });
            return Ok(());
        }
        
        return Err(SettlementTrackerError::AlreadyPaid(AlreadyPaid {}));
    }

    // check if a payment has been settled for some given hash 
    pub fn check_settlement(
        &self, 
        commitment: FixedBytes<32>, 
        user: Address
    ) -> bool {
        let hash = hash_concat(commitment.as_slice(), user.as_slice());
        self.settlement_tracker.get(hash)
    }
}
fn hash_concat(a: &[u8], b: &[u8]) -> FixedBytes<32> {
    let mut data = Vec::with_capacity(a.len() + b.len());
    data.extend_from_slice(a);
    data.extend_from_slice(b);
    keccak256(&data)
}