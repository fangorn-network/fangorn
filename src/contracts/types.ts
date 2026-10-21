export enum PublisherStatus {
    NONE = 0,
    ACTIVE = 1,
    SUSPENDED = 2,
    /** Retired: invited under the old join flow and never joined. Not a member. */
    INVITED = 3,
}