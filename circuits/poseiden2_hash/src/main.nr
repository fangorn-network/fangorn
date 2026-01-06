use dep::poseidon2;

fn main(value1: pub Field, value2: pub Field) -> pub  Field {
    let commitment = poseidon2::bn254::hash_2([value1, value2]);
    commitment
}