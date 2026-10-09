// C# -> page: HostBridge.Send calls this, and the page template's window.bankrollBridge posts it to the
// Bankroll app. Only included in web builds.
mergeInto(LibraryManager.library, {
  BankrollBridge_Send: function (type, payloadJson) {
    var messageType = UTF8ToString(type);
    var payload = payloadJson ? UTF8ToString(payloadJson) : '';
    if (typeof window !== 'undefined' && window.bankrollBridge) {
      window.bankrollBridge.send(messageType, payload);
    }
  },
});
