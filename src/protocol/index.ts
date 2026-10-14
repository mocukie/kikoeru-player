// 主執行緒、media Worker 與 AudioWorklet 之間的訊息型別。只放 type，不放 runtime 程式碼。

/** 每則訊息共用的欄位；實際的訊息型別由後續 issue 加入。 */
export interface MessageBase {
  readonly type: string;
}
