export enum PublisherStatus {
    NONE = 0,
    ACTIVE = 1,
    SUSPENDED = 2,
    /** AppRegistry only: added by the app owner, terms not yet accepted. */
    INVITED = 3,
}