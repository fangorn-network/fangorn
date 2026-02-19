// import type { PredicateConfig } from "./types.js";
// import { PaymentPredicate } from "./payment.js";
// import { Hex } from "viem";

// /**
//  * Build predicates
//  */
// export class PredicateBuilder {
//   private config: PredicateConfig;

//   constructor(config: PredicateConfig) {
//     this.config = config;
//   }

//   /**
//    * Create a payment predicate: decrypt only after payment is verified
//    */
//   payment(commitment: Hex): PaymentPredicate {
//     return new PaymentPredicate(this.config, { commitment });
//   }

//   // Add future predicates here
// }

// // Convenience factory
// export function predicates(config: PredicateConfig): PredicateBuilder {
//   return new PredicateBuilder(config);
// }
