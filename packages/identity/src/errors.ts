/** Коды ошибок identity — зеркало `control_plane_client.iam.IamCredentialError`. */
export type IdentityErrorCode =
  | 'iam_not_authenticated'
  | 'iam_credential_ambiguous'
  | 'iam_environment_mode_required'
  | 'iam_invalid_token'
  | 'iam_audience_not_allowed'
  | 'iam_exchange_failed'
  | 'iam_exchange_malformed'
  | 'iam_unreachable'

/** Identity не удалось разрешить или обменять. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode

  constructor(code: IdentityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IdentityError'
    this.code = code
  }
}
