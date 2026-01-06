use dep::poseidon2;

fn main(value: pub Field) -> pub Field {
    poseidon2::bn254::hash_1([value])
}