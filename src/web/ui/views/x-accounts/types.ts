export type AccountStatus = "unverified" | "active" | "expired" | "error";

export interface XAccount {
  id: string;
  label: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  auth_token: string;
  ct0: string;
  status: AccountStatus;
  verified_at: number | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export type FeatureTab = 'timeline' | 'auto-likes' | 'auto-follow' | 'bookmarks';

export interface AccountsResponse {
  success: boolean;
  data: XAccount[];
}

export interface AccountResponse {
  success: boolean;
  data: XAccount;
}

export interface MutationResponse {
  success: boolean;
  message?: string;
  error?: string;
}
