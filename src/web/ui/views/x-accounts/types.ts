export type AccountStatus = "unverified" | "active" | "expired" | "error";

export interface XAccount {
  readonly id: string;
  readonly label: string;
  readonly username: string | null;
  readonly display_name: string | null;
  readonly profile_image_url: string | null;
  readonly auth_token: string;
  readonly ct0: string;
  readonly status: AccountStatus;
  readonly verified_at: number | null;
  readonly error_message: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export type FeatureTab = "timeline" | "auto-likes" | "auto-follow" | "bookmarks";

export interface AccountsResponse {
  readonly success: boolean;
  readonly data: readonly XAccount[];
}

export interface AccountResponse {
  readonly success: boolean;
  readonly data: XAccount;
}

export interface MutationResponse {
  readonly success: boolean;
  readonly message?: string;
  readonly error?: string;
}
