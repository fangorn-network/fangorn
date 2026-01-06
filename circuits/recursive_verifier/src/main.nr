// aggregator.nr
use dep::std::verify_proof;

fn main(
    // PUBLIC: What we're proving
    condition_root: pub Field,
    predicate_ids: pub [Field; MAX_PREDICATES],
    num_predicates: pub Field,
    
    // PRIVATE: The proofs themselves
    proofs: [Proof; MAX_PREDICATES],
    vks: [VerificationKey; MAX_PREDICATES],
    public_inputs: [[Field; MAX_INPUTS]; MAX_PREDICATES],
) {
    // Verify each sub-proof
    for i in 0..MAX_PREDICATES {
        if i < num_predicates {
            assert(verify_proof(vks[i], proofs[i], public_inputs[i]));
            
            // Verify VK matches registered predicate
            let vk_hash = hash_vk(vks[i]);
            assert(vk_hash == get_registered_vk_hash(predicate_ids[i]));
        }
    }
    
    // Verify predicates form the expected condition tree
    let computed_root = compute_condition_root(predicate_ids, num_predicates);
    assert(computed_root == condition_root);
}