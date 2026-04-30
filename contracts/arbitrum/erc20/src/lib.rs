#![cfg_attr(not(feature = "export-abi"), no_main)]
extern crate alloc;

use alloy_primitives::{Address, U256};
use alloy_sol_types::sol;
use stylus_sdk::{
    prelude::*,
};

// Define events
sol! {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

sol_storage! {
    #[entrypoint]
    pub struct Erc20 {
        bool initialized;
        address owner;
        uint256 total_supply;
        mapping(address => uint256) balances;
        mapping(address => mapping(address => uint256)) allowances;
    }
}

#[public]
impl Erc20 {
    pub fn init(&mut self) -> Result<(), Vec<u8>> {
        if self.initialized.get() { return Err("Already initialized".into()); }
        self.initialized.set(true);
        self.owner.set(self.vm().msg_sender());
        Ok(())
    }

    pub fn name(&self) -> String { "Stylus Token".to_string() }
    pub fn symbol(&self) -> String { "STYL".to_string() }
    pub fn decimals(&self) -> u8 { 18 }
    pub fn total_supply(&self) -> U256 { self.total_supply.get() }
    pub fn balance_of(&self, account: Address) -> U256 { self.balances.get(account) }

    pub fn transfer(&mut self, to: Address, amount: U256) -> bool {
        let sender = self.vm().msg_sender();
        let balance = self.balances.get(sender);
        if balance < amount { return false; }

        self.balances.insert(sender, balance - amount);
        self.balances.insert(to, self.balances.get(to) + amount);

        // Emit via the VM instance directly
        self.vm().log(Transfer { from: sender, to, value: amount });
        true
    }

    pub fn mint(&mut self, account: Address, amount: U256) -> bool {
        if self.vm().msg_sender() != self.owner.get() { return false; }

        self.total_supply.set(self.total_supply.get() + amount);
        self.balances.insert(account, self.balances.get(account) + amount);

        self.vm().log(Transfer { from: Address::ZERO, to: account, value: amount });
        true
    }
}