// A circuit for proving you know the preimage with a nullifier for replay protection

use dep::keccak256::keccak256;
use dep::poseidon2;
use dep::std;

// Merkle tree depth
// 8 levels => 2^8 = 256 max CIDs, 16 levels => 2^16 = 65536 max CIDs
global TREE_DEPTH: u32 = 8;

// TODO: should we salt the password? e.g. to prevent rainbow table attacks
// TODO: can tree depth be dynamic?
fn main(
    // Private inputs
    password: [u8; 32],
    merkle_path: [Field; TREE_DEPTH],
    merkle_indices: [Field; TREE_DEPTH],
    
    // Public inputs
    expected_hash: pub [u8; 32],
    merkle_root: pub Field,
    user_address: pub [u8; 32],
    vault_id: pub [u8; 32],
    nullifier: pub [u8; 32],
    cid_commitment: pub Field,
) {
    // verify password
    let hash_out = keccak256(password, 32);
    assert_eq(hash_out, expected_hash);
    
    // verify CID is in Merkle tree
    let computed_root = compute_merkle_root(cid_commitment, merkle_indices, merkle_path);
    assert_eq(computed_root, merkle_root);
    
    // verify nullifier
    let mut nullifier_input: [u8; 128] = [0; 128];
    let cid_bytes: [u8; 32] = cid_commitment.to_be_bytes::<32>();
    for i in 0..32 {
        nullifier_input[i] = password[i];
        nullifier_input[i + 32] = user_address[i];
        nullifier_input[i + 64] = vault_id[i];
        nullifier_input[i + 96] = cid_bytes[i];
    }
    assert_eq(std::hash::blake3(nullifier_input), nullifier);
}

fn compute_merkle_root(leaf: Field, path_indices: [Field; TREE_DEPTH], siblings: [Field; TREE_DEPTH]) -> Field {
    let mut current = leaf;
    for i in 0..TREE_DEPTH {
        let is_right = (path_indices[i] == 1) as bool;
        let (left, right) = if is_right {
            (siblings[i], current)
        } else {
            (current, siblings[i])
        };
        current = poseidon2::bn254::hash_2([left, right]);
    }
    current
}

#[test]
fn test_valid_proof() {
    let password: [u8; 32] = [1; 32];
    let expected_hash = keccak256(password, 32);

    let user_address: [u8; 32] = [2; 32];
    let vault_id: [u8; 32] = [3; 32];

    let cid_commitment: Field = 12345;
    let cid_bytes: [u8; 32] = cid_commitment.to_be_bytes::<32>();

    let merkle_path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    let merkle_indices: [Field; TREE_DEPTH] = [0; TREE_DEPTH];

    let mut current = cid_commitment;
    for i in 0..TREE_DEPTH {
        current = poseidon2::bn254::hash_2([current, merkle_path[i]]);
    }
    let merkle_root = current;

    let mut nullifier_input: [u8; 128] = [0; 128];
    for i in 0..32 {
        nullifier_input[i] = password[i];
        nullifier_input[i + 32] = user_address[i];
        nullifier_input[i + 64] = vault_id[i];
        nullifier_input[i + 96] = cid_bytes[i];
    }
    let nullifier = std::hash::blake3(nullifier_input);

    main(
        password,
        merkle_path,
        merkle_indices,
        expected_hash,
        merkle_root,
        user_address,
        vault_id,
        nullifier,
        cid_commitment,
    );
}

#[test]
fn test_multiple_leaves() {
    let password: [u8; 32] = [1; 32];
    let expected_hash = keccak256(password, 32);

    let user_address: [u8; 32] = [2; 32];
    let vault_id: [u8; 32] = [3; 32];

    let cid_commitment: Field = 111;
    let other_leaf: Field = 222;
    let cid_bytes: [u8; 32] = cid_commitment.to_be_bytes::<32>();

    let mut merkle_path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    merkle_path[0] = other_leaf;

    let merkle_indices: [Field; TREE_DEPTH] = [0; TREE_DEPTH];

    let mut current = cid_commitment;
    for i in 0..TREE_DEPTH {
        let sibling = merkle_path[i];
        current = poseidon2::bn254::hash_2([current, sibling]);
    }
    let merkle_root = current;

    let mut nullifier_input: [u8; 128] = [0; 128];
    for i in 0..32 {
        nullifier_input[i] = password[i];
        nullifier_input[i + 32] = user_address[i];
        nullifier_input[i + 64] = vault_id[i];
        nullifier_input[i + 96] = cid_bytes[i];
    }
    let nullifier = std::hash::blake3(nullifier_input);

    main(
        password,
        merkle_path,
        merkle_indices,
        expected_hash,
        merkle_root,
        user_address,
        vault_id,
        nullifier,
        cid_commitment,
    );
}

#[test]
fn test_leaf_at_index_1() {
    let password: [u8; 32] = [1; 32];
    let expected_hash = keccak256(password, 32);

    let user_address: [u8; 32] = [2; 32];
    let vault_id: [u8; 32] = [3; 32];

    let first_leaf: Field = 111;
    let cid_commitment: Field = 222;
    let cid_bytes: [u8; 32] = cid_commitment.to_be_bytes::<32>();

    let mut merkle_path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    merkle_path[0] = first_leaf;

    let mut merkle_indices: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    merkle_indices[0] = 1;

    let mut current = cid_commitment;
    for i in 0..TREE_DEPTH {
        let sibling = merkle_path[i];
        let is_right = (merkle_indices[i] == 1) as bool;
        let (left, right) = if is_right {
            (sibling, current)
        } else {
            (current, sibling)
        };
        current = poseidon2::bn254::hash_2([left, right]);
    }
    let merkle_root = current;

    let mut nullifier_input: [u8; 128] = [0; 128];
    for i in 0..32 {
        nullifier_input[i] = password[i];
        nullifier_input[i + 32] = user_address[i];
        nullifier_input[i + 64] = vault_id[i];
        nullifier_input[i + 96] = cid_bytes[i];
    }
    let nullifier = std::hash::blake3(nullifier_input);

    main(
        password,
        merkle_path,
        merkle_indices,
        expected_hash,
        merkle_root,
        user_address,
        vault_id,
        nullifier,
        cid_commitment,
    );
}

#[test(should_fail)]
fn test_wrong_password_fails() {
    let password: [u8; 32] = [1; 32];
    let wrong_password: [u8; 32] = [9; 32];
    let expected_hash = keccak256(password, 32);

    let user_address: [u8; 32] = [2; 32];
    let vault_id: [u8; 32] = [3; 32];

    let cid_commitment: Field = 12345;
    let cid_bytes: [u8; 32] = cid_commitment.to_be_bytes::<32>();

    let merkle_path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    let merkle_indices: [Field; TREE_DEPTH] = [0; TREE_DEPTH];

    let mut current = cid_commitment;
    for i in 0..TREE_DEPTH {
        current = poseidon2::bn254::hash_2([current, merkle_path[i]]);
    }
    let merkle_root = current;

    let mut nullifier_input: [u8; 128] = [0; 128];
    for i in 0..32 {
        nullifier_input[i] = wrong_password[i];
        nullifier_input[i + 32] = user_address[i];
        nullifier_input[i + 64] = vault_id[i];
        nullifier_input[i + 96] = cid_bytes[i];
    }
    let nullifier = std::hash::blake3(nullifier_input);

    main(
        wrong_password,
        merkle_path,
        merkle_indices,
        expected_hash,
        merkle_root,
        user_address,
        vault_id,
        nullifier,
        cid_commitment,
    );
}

#[test(should_fail)]
fn test_wrong_cid_fails() {
    let password: [u8; 32] = [1; 32];
    let expected_hash = keccak256(password, 32);

    let user_address: [u8; 32] = [2; 32];
    let vault_id: [u8; 32] = [3; 32];

    let real_cid: Field = 111;
    let fake_cid: Field = 999;
    let fake_cid_bytes: [u8; 32] = fake_cid.to_be_bytes::<32>();

    let merkle_path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    let merkle_indices: [Field; TREE_DEPTH] = [0; TREE_DEPTH];

    // Tree built with real_cid
    let mut current = real_cid;
    for i in 0..TREE_DEPTH {
        current = poseidon2::bn254::hash_2([current, merkle_path[i]]);
    }
    let merkle_root = current;

    let mut nullifier_input: [u8; 128] = [0; 128];
    for i in 0..32 {
        nullifier_input[i] = password[i];
        nullifier_input[i + 32] = user_address[i];
        nullifier_input[i + 64] = vault_id[i];
        nullifier_input[i + 96] = fake_cid_bytes[i];
    }
    let nullifier = std::hash::blake3(nullifier_input);

    // Should fail: fake_cid doesn't produce merkle_root
    main(
        password,
        merkle_path,
        merkle_indices,
        expected_hash,
        merkle_root,
        user_address,
        vault_id,
        nullifier,
        fake_cid,
    );
}

#[test(should_fail)]
fn test_wrong_nullifier_fails() {
    let password: [u8; 32] = [1; 32];
    let expected_hash = keccak256(password, 32);

    let user_address: [u8; 32] = [2; 32];
    let vault_id: [u8; 32] = [3; 32];

    let cid_commitment: Field = 12345;

    let merkle_path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    let merkle_indices: [Field; TREE_DEPTH] = [0; TREE_DEPTH];

    let mut current = cid_commitment;
    for i in 0..TREE_DEPTH {
        current = poseidon2::bn254::hash_2([current, merkle_path[i]]);
    }
    let merkle_root = current;

    let wrong_nullifier: [u8; 32] = [42; 32];

    main(
        password,
        merkle_path,
        merkle_indices,
        expected_hash,
        merkle_root,
        user_address,
        vault_id,
        wrong_nullifier,
        cid_commitment,
    );
}

#[test(should_fail)]
fn test_wrong_user_address_in_nullifier_fails() {
    let password: [u8; 32] = [1; 32];
    let expected_hash = keccak256(password, 32);

    let user_address: [u8; 32] = [2; 32];
    let wrong_user: [u8; 32] = [5; 32];
    let vault_id: [u8; 32] = [3; 32];

    let cid_commitment: Field = 12345;
    let cid_bytes: [u8; 32] = cid_commitment.to_be_bytes::<32>();

    let merkle_path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    let merkle_indices: [Field; TREE_DEPTH] = [0; TREE_DEPTH];

    let mut current = cid_commitment;
    for i in 0..TREE_DEPTH {
        current = poseidon2::bn254::hash_2([current, merkle_path[i]]);
    }
    let merkle_root = current;

    // Nullifier computed with wrong_user
    let mut nullifier_input: [u8; 128] = [0; 128];
    for i in 0..32 {
        nullifier_input[i] = password[i];
        nullifier_input[i + 32] = wrong_user[i];
        nullifier_input[i + 64] = vault_id[i];
        nullifier_input[i + 96] = cid_bytes[i];
    }
    let nullifier = std::hash::blake3(nullifier_input);

    main(
        password,
        merkle_path,
        merkle_indices,
        expected_hash,
        merkle_root,
        user_address,
        vault_id,
        nullifier,
        cid_commitment,
    );
}

#[test(should_fail)]
fn test_wrong_vault_in_nullifier_fails() {
    let password: [u8; 32] = [1; 32];
    let expected_hash = keccak256(password, 32);

    let user_address: [u8; 32] = [2; 32];
    let vault_id: [u8; 32] = [3; 32];
    let wrong_vault: [u8; 32] = [9; 32];

    let cid_commitment: Field = 12345;
    let cid_bytes: [u8; 32] = cid_commitment.to_be_bytes::<32>();

    let merkle_path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    let merkle_indices: [Field; TREE_DEPTH] = [0; TREE_DEPTH];

    let mut current = cid_commitment;
    for i in 0..TREE_DEPTH {
        current = poseidon2::bn254::hash_2([current, merkle_path[i]]);
    }
    let merkle_root = current;

    // Nullifier computed with wrong_vault
    let mut nullifier_input: [u8; 128] = [0; 128];
    for i in 0..32 {
        nullifier_input[i] = password[i];
        nullifier_input[i + 32] = user_address[i];
        nullifier_input[i + 64] = wrong_vault[i];
        nullifier_input[i + 96] = cid_bytes[i];
    }
    let nullifier = std::hash::blake3(nullifier_input);

    main(
        password,
        merkle_path,
        merkle_indices,
        expected_hash,
        merkle_root,
        user_address,
        vault_id,
        nullifier,
        cid_commitment,
    );
}