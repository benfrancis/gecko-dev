/* Copyright 2012 Mozilla Foundation and Mozilla contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Sntp.jsm");
Cu.import("resource://gre/modules/systemlibs.js");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "RIL", function () {
  let obj = {};
  Cu.import("resource://gre/modules/ril_consts.js", obj);
  return obj;
});

// Ril quirk to attach data registration on demand.
let RILQUIRKS_DATA_REGISTRATION_ON_DEMAND =
  libcutils.property_get("ro.moz.ril.data_reg_on_demand", "false") == "true";

// Ril quirk to control the uicc/data subscription.
let RILQUIRKS_SUBSCRIPTION_CONTROL =
  libcutils.property_get("ro.moz.ril.subscription_control", "false") == "true";

// Ril quirk to always turn the radio off for the client without SIM card
// except hw default client.
let RILQUIRKS_RADIO_OFF_WO_CARD =
  libcutils.property_get("ro.moz.ril.radio_off_wo_card", "false") == "true";

// Ril quirk to enable IPv6 protocol/roaming protocol in APN settings.
let RILQUIRKS_HAVE_IPV6 =
  libcutils.property_get("ro.moz.ril.ipv6", "false") == "true";

const RADIOINTERFACELAYER_CID =
  Components.ID("{2d831c8d-6017-435b-a80c-e5d422810cea}");
const RADIOINTERFACE_CID =
  Components.ID("{6a7c91f0-a2b3-4193-8562-8969296c0b54}");
const RILNETWORKINTERFACE_CID =
  Components.ID("{3bdd52a9-3965-4130-b569-0ac5afed045e}");
const NEIGHBORINGCELLINFO_CID =
  Components.ID("{f9dfe26a-851e-4a8b-a769-cbb1baae7ded}");
const GSMCELLINFO_CID =
  Components.ID("{41f6201e-7263-42e3-b31f-38a9dc8a280a}");
const WCDMACELLINFO_CID =
  Components.ID("{eeaaf307-df6e-4c98-b121-e3302b1fc468}");
const CDMACELLINFO_CID =
  Components.ID("{b497d6e4-4cb8-4d6e-b673-840c7d5ddf25}");
const LTECELLINFO_CID =
  Components.ID("{c7e0a78a-4e99-42f5-9251-e6172c5ed8d8}");

const NS_XPCOM_SHUTDOWN_OBSERVER_ID      = "xpcom-shutdown";
const kNetworkConnStateChangedTopic      = "network-connection-state-changed";
const kSmsReceivedObserverTopic          = "sms-received";
const kSilentSmsReceivedObserverTopic    = "silent-sms-received";
const kSmsSendingObserverTopic           = "sms-sending";
const kSmsSentObserverTopic              = "sms-sent";
const kSmsFailedObserverTopic            = "sms-failed";
const kSmsDeliverySuccessObserverTopic   = "sms-delivery-success";
const kSmsDeliveryErrorObserverTopic     = "sms-delivery-error";
const kMozSettingsChangedObserverTopic   = "mozsettings-changed";
const kSysMsgListenerReadyObserverTopic  = "system-message-listener-ready";
const kSysClockChangeObserverTopic       = "system-clock-change";
const kScreenStateChangedTopic           = "screen-state-changed";

const kSettingsClockAutoUpdateEnabled = "time.clock.automatic-update.enabled";
const kSettingsClockAutoUpdateAvailable = "time.clock.automatic-update.available";
const kSettingsTimezoneAutoUpdateEnabled = "time.timezone.automatic-update.enabled";
const kSettingsTimezoneAutoUpdateAvailable = "time.timezone.automatic-update.available";

const NS_PREFBRANCH_PREFCHANGE_TOPIC_ID = "nsPref:changed";

const kPrefRilNumRadioInterfaces = "ril.numRadioInterfaces";
const kPrefRilDebuggingEnabled = "ril.debugging.enabled";

const DOM_MOBILE_MESSAGE_DELIVERY_RECEIVED = "received";
const DOM_MOBILE_MESSAGE_DELIVERY_SENDING  = "sending";
const DOM_MOBILE_MESSAGE_DELIVERY_SENT     = "sent";
const DOM_MOBILE_MESSAGE_DELIVERY_ERROR    = "error";

const RADIO_POWER_OFF_TIMEOUT = 30000;
const SMS_HANDLED_WAKELOCK_TIMEOUT = 5000;
const HW_DEFAULT_CLIENT_ID = 0;

const INT32_MAX = 2147483647;
const UNKNOWN_RSSI = 99;

const RIL_IPC_ICCMANAGER_MSG_NAMES = [
  "RIL:GetRilContext",
  "RIL:SendStkResponse",
  "RIL:SendStkMenuSelection",
  "RIL:SendStkTimerExpiration",
  "RIL:SendStkEventDownload",
  "RIL:GetCardLockState",
  "RIL:UnlockCardLock",
  "RIL:SetCardLock",
  "RIL:GetCardLockRetryCount",
  "RIL:IccOpenChannel",
  "RIL:IccExchangeAPDU",
  "RIL:IccCloseChannel",
  "RIL:ReadIccContacts",
  "RIL:UpdateIccContact",
  "RIL:RegisterIccMsg",
  "RIL:MatchMvno"
];

// set to true in ril_consts.js to see debug messages
var DEBUG = RIL.DEBUG_RIL;

function updateDebugFlag() {
  // Read debug setting from pref
  let debugPref;
  try {
    debugPref = Services.prefs.getBoolPref(kPrefRilDebuggingEnabled);
  } catch (e) {
    debugPref = false;
  }
  DEBUG = RIL.DEBUG_RIL || debugPref;
}
updateDebugFlag();

function debug(s) {
  dump("-*- RadioInterfaceLayer: " + s + "\n");
}

XPCOMUtils.defineLazyServiceGetter(this, "gPowerManagerService",
                                   "@mozilla.org/power/powermanagerservice;1",
                                   "nsIPowerManagerService");

XPCOMUtils.defineLazyServiceGetter(this, "gMobileMessageService",
                                   "@mozilla.org/mobilemessage/mobilemessageservice;1",
                                   "nsIMobileMessageService");

XPCOMUtils.defineLazyServiceGetter(this, "gSmsService",
                                   "@mozilla.org/sms/smsservice;1",
                                   "nsISmsService");

XPCOMUtils.defineLazyServiceGetter(this, "gMobileMessageDatabaseService",
                                   "@mozilla.org/mobilemessage/rilmobilemessagedatabaseservice;1",
                                   "nsIRilMobileMessageDatabaseService");

XPCOMUtils.defineLazyServiceGetter(this, "ppmm",
                                   "@mozilla.org/parentprocessmessagemanager;1",
                                   "nsIMessageBroadcaster");

XPCOMUtils.defineLazyServiceGetter(this, "gSettingsService",
                                   "@mozilla.org/settingsService;1",
                                   "nsISettingsService");

XPCOMUtils.defineLazyServiceGetter(this, "gSystemMessenger",
                                   "@mozilla.org/system-message-internal;1",
                                   "nsISystemMessagesInternal");

XPCOMUtils.defineLazyServiceGetter(this, "gNetworkManager",
                                   "@mozilla.org/network/manager;1",
                                   "nsINetworkManager");

XPCOMUtils.defineLazyServiceGetter(this, "gTimeService",
                                   "@mozilla.org/time/timeservice;1",
                                   "nsITimeService");

XPCOMUtils.defineLazyServiceGetter(this, "gSystemWorkerManager",
                                   "@mozilla.org/telephony/system-worker-manager;1",
                                   "nsISystemWorkerManager");

XPCOMUtils.defineLazyServiceGetter(this, "gTelephonyService",
                                   "@mozilla.org/telephony/telephonyservice;1",
                                   "nsIGonkTelephonyService");

XPCOMUtils.defineLazyServiceGetter(this, "gMobileConnectionService",
                                   "@mozilla.org/mobileconnection/mobileconnectionservice;1",
                                   "nsIGonkMobileConnectionService");

XPCOMUtils.defineLazyServiceGetter(this, "gCellBroadcastService",
                                   "@mozilla.org/cellbroadcast/gonkservice;1",
                                   "nsIGonkCellBroadcastService");

XPCOMUtils.defineLazyGetter(this, "WAP", function() {
  let wap = {};
  Cu.import("resource://gre/modules/WapPushManager.js", wap);
  return wap;
});

XPCOMUtils.defineLazyGetter(this, "PhoneNumberUtils", function() {
  let ns = {};
  Cu.import("resource://gre/modules/PhoneNumberUtils.jsm", ns);
  return ns.PhoneNumberUtils;
});

XPCOMUtils.defineLazyGetter(this, "gMessageManager", function() {
  return {
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIMessageListener,
                                           Ci.nsIObserver]),

    ril: null,

    // Manage message targets in terms of topic. Only the authorized and
    // registered contents can receive related messages.
    targetsByTopic: {},
    topics: [],

    targetMessageQueue: [],
    ready: false,

    init: function(ril) {
      this.ril = ril;

      Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
      Services.obs.addObserver(this, kSysMsgListenerReadyObserverTopic, false);
      this._registerMessageListeners();
    },

    _shutdown: function() {
      this.ril = null;

      Services.obs.removeObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
      this._unregisterMessageListeners();
    },

    _registerMessageListeners: function() {
      ppmm.addMessageListener("child-process-shutdown", this);
      for (let msgName of RIL_IPC_ICCMANAGER_MSG_NAMES) {
        ppmm.addMessageListener(msgName, this);
      }
    },

    _unregisterMessageListeners: function() {
      ppmm.removeMessageListener("child-process-shutdown", this);
      for (let msgName of RIL_IPC_ICCMANAGER_MSG_NAMES) {
        ppmm.removeMessageListener(msgName, this);
      }
      ppmm = null;
    },

    _registerMessageTarget: function(topic, target) {
      let targets = this.targetsByTopic[topic];
      if (!targets) {
        targets = this.targetsByTopic[topic] = [];
        let list = this.topics;
        if (list.indexOf(topic) == -1) {
          list.push(topic);
        }
      }

      if (targets.indexOf(target) != -1) {
        if (DEBUG) debug("Already registered this target!");
        return;
      }

      targets.push(target);
      if (DEBUG) debug("Registered " + topic + " target: " + target);
    },

    _unregisterMessageTarget: function(topic, target) {
      if (topic == null) {
        // Unregister the target for every topic when no topic is specified.
        for (let type of this.topics) {
          this._unregisterMessageTarget(type, target);
        }
        return;
      }

      // Unregister the target for a specified topic.
      let targets = this.targetsByTopic[topic];
      if (!targets) {
        return;
      }

      let index = targets.indexOf(target);
      if (index != -1) {
        targets.splice(index, 1);
        if (DEBUG) debug("Unregistered " + topic + " target: " + target);
      }
    },

    _enqueueTargetMessage: function(topic, message, options) {
      let msg = { topic : topic,
                  message : message,
                  options : options };
      // Remove previous queued message with the same message type and client Id
      // , only one message per (message type + client Id) is allowed in queue.
      let messageQueue = this.targetMessageQueue;
      for(let i = 0; i < messageQueue.length; i++) {
        if (messageQueue[i].message === message &&
            messageQueue[i].options.clientId === options.clientId) {
          messageQueue.splice(i, 1);
          break;
        }
      }

      messageQueue.push(msg);
    },

    _sendTargetMessage: function(topic, message, options) {
      if (!this.ready) {
        this._enqueueTargetMessage(topic, message, options);
        return;
      }

      let targets = this.targetsByTopic[topic];
      if (!targets) {
        return;
      }

      for (let target of targets) {
        target.sendAsyncMessage(message, options);
      }
    },

    _resendQueuedTargetMessage: function() {
      this.ready = true;

      // Here uses this._sendTargetMessage() to resend message, which will
      // enqueue message if listener is not ready.
      // So only resend after listener is ready, or it will cause infinate loop and
      // hang the system.

      // Dequeue and resend messages.
      for each (let msg in this.targetMessageQueue) {
        this._sendTargetMessage(msg.topic, msg.message, msg.options);
      }
      this.targetMessageQueue = null;
    },

    /**
     * nsIMessageListener interface methods.
     */

    receiveMessage: function(msg) {
      if (DEBUG) debug("Received '" + msg.name + "' message from content process");
      if (msg.name == "child-process-shutdown") {
        // By the time we receive child-process-shutdown, the child process has
        // already forgotten its permissions so we need to unregister the target
        // for every permission.
        this._unregisterMessageTarget(null, msg.target);
        return null;
      }

      if (RIL_IPC_ICCMANAGER_MSG_NAMES.indexOf(msg.name) != -1) {
        if (!msg.target.assertPermission("mobileconnection")) {
          if (DEBUG) {
            debug("IccManager message " + msg.name +
                  " from a content process with no 'mobileconnection' privileges.");
          }
          return null;
        }
      } else {
        if (DEBUG) debug("Ignoring unknown message type: " + msg.name);
        return null;
      }

      switch (msg.name) {
        case "RIL:RegisterIccMsg":
          this._registerMessageTarget("icc", msg.target);
          return null;
      }

      let clientId = msg.json.clientId || 0;
      let radioInterface = this.ril.getRadioInterface(clientId);
      if (!radioInterface) {
        if (DEBUG) debug("No such radio interface: " + clientId);
        return null;
      }

      return radioInterface.receiveMessage(msg);
    },

    /**
     * nsIObserver interface methods.
     */

    observe: function(subject, topic, data) {
      switch (topic) {
        case kSysMsgListenerReadyObserverTopic:
          Services.obs.removeObserver(this, kSysMsgListenerReadyObserverTopic);
          this._resendQueuedTargetMessage();
          break;
        case NS_XPCOM_SHUTDOWN_OBSERVER_ID:
          this._shutdown();
          break;
      }
    },

    sendIccMessage: function(message, clientId, data) {
      this._sendTargetMessage("icc", message, {
        clientId: clientId,
        data: data
      });
    }
  };
});

XPCOMUtils.defineLazyGetter(this, "gRadioEnabledController", function() {
  let _ril = null;
  let _pendingMessages = [];  // For queueing "setRadioEnabled" message.
  let _isProcessingPending = false;
  let _timer = null;
  let _request = null;
  let _deactivatingDeferred = {};
  let _initializedCardState = {};
  let _allCardStateInitialized = !RILQUIRKS_RADIO_OFF_WO_CARD;

  return {
    init: function(ril) {
      _ril = ril;
    },

    receiveCardState: function(clientId) {
      if (_allCardStateInitialized) {
        return;
      }

      if (DEBUG) debug("RadioControl: receive cardState from " + clientId);
      _initializedCardState[clientId] = true;
      if (Object.keys(_initializedCardState).length == _ril.numRadioInterfaces) {
        _allCardStateInitialized = true;
        this._startProcessingPending();
      }
    },

    setRadioEnabled: function(clientId, data, callback) {
      if (DEBUG) debug("setRadioEnabled: " + clientId + ": " + JSON.stringify(data));
      let message = {
        clientId: clientId,
        data: data,
        callback: callback
      };
      _pendingMessages.push(message);
      this._startProcessingPending();
    },

    isDeactivatingDataCalls: function() {
      return _request !== null;
    },

    finishDeactivatingDataCalls: function(clientId) {
      if (DEBUG) debug("RadioControl: finishDeactivatingDataCalls: " + clientId);
      let deferred = _deactivatingDeferred[clientId];
      if (deferred) {
        deferred.resolve();
      }
    },

    notifyRadioStateChanged: function(clientId, radioState) {
      gMobileConnectionService.notifyRadioStateChanged(clientId, radioState);
    },

    _startProcessingPending: function() {
      if (!_isProcessingPending) {
        if (DEBUG) debug("RadioControl: start dequeue");
        _isProcessingPending = true;
        this._processNextMessage();
      }
    },

    _processNextMessage: function() {
      if (_pendingMessages.length === 0 || !_allCardStateInitialized) {
        if (DEBUG) debug("RadioControl: stop dequeue");
        _isProcessingPending = false;
        return;
      }

      let msg = _pendingMessages.shift();
      this._handleMessage(msg);
    },

    _getNumCards: function() {
      let numCards = 0;
      for (let i = 0, N = _ril.numRadioInterfaces; i < N; ++i) {
        if (this._isCardPresentAtClient(i)) {
          numCards++;
        }
      }
      return numCards;
    },

    _isCardPresentAtClient: function(clientId) {
      let cardState = _ril.getRadioInterface(clientId).rilContext.cardState;
      return cardState !== Ci.nsIIccProvider.CARD_STATE_UNDETECTED &&
             cardState !== Ci.nsIIccProvider.CARD_STATE_UNKNOWN;
    },

    _isRadioAbleToEnableAtClient: function(clientId, numCards) {
      if (!RILQUIRKS_RADIO_OFF_WO_CARD) {
        return true;
      }

      // We could only turn on the radio for clientId if
      // 1. a SIM card is presented or
      // 2. it is the default clientId and there is no any SIM card at any client.

      if (this._isCardPresentAtClient(clientId)) {
        return true;
      }

      numCards = numCards == null ? this._getNumCards() : numCards;
      if (clientId === HW_DEFAULT_CLIENT_ID && numCards === 0) {
        return true;
      }

      return false;
    },

    _isValidStateForSetRadioEnabled: function(radioState) {
      return radioState == RIL.GECKO_RADIOSTATE_ENABLED ||
             radioState == RIL.GECKO_RADIOSTATE_DISABLED;
    },

    _isDummyForSetRadioEnabled: function(radioState, data) {
      return (radioState == RIL.GECKO_RADIOSTATE_ENABLED && data.enabled) ||
             (radioState == RIL.GECKO_RADIOSTATE_DISABLED && !data.enabled);
    },

    _handleMessage: function(message) {
      if (DEBUG) debug("RadioControl: handleMessage: " + JSON.stringify(message));
      let clientId = message.clientId || 0;
      let connection =
        gMobileConnectionService.getItemByServiceId(clientId);
      let radioState = connection && connection.radioState;

      if (!this._isValidStateForSetRadioEnabled(radioState)) {
        message.data.errorMsg = "InvalidStateError";
        message.callback(message.data);
        this._processNextMessage();
        return;
      }

      if (this._isDummyForSetRadioEnabled(radioState, message.data)) {
        message.callback(message.data);
        this._processNextMessage();
        return;
      }

      if (message.data.enabled) {
        if (this._isRadioAbleToEnableAtClient(clientId)) {
          this._setRadioEnabledInternal(message);
        } else {
          // Not really do it but respond success.
          message.callback(message.data);
        }

        this._processNextMessage();
      } else {
        _request = this._setRadioEnabledInternal.bind(this, message);

        // In 2G network, modem takes 35+ seconds to process deactivate data
        // call request if device has active voice call (please see bug 964974
        // for more details). Therefore we should hangup all active voice calls
        // first. And considering some DSDS architecture, toggling one radio may
        // toggle both, so we send hangUpAll to all clients.
        for (let i = 0, N = _ril.numRadioInterfaces; i < N; ++i) {
          let iface = _ril.getRadioInterface(i);
          iface.workerMessenger.send("hangUpAll");
        }

        // In some DSDS architecture with only one modem, toggling one radio may
        // toggle both. Therefore, for safely turning off, we should first
        // explicitly deactivate all data calls from all clients.
        this._deactivateDataCalls().then(() => {
          if (DEBUG) debug("RadioControl: deactivation done");
          this._executeRequest();
        });

        this._createTimer();
      }
    },

    _setRadioEnabledInternal: function(message) {
      let clientId = message.clientId || 0;
      let enabled = message.data.enabled || false;
      let radioInterface = _ril.getRadioInterface(clientId);

      this.notifyRadioStateChanged(clientId,
                                   enabled ? RIL.GECKO_RADIOSTATE_ENABLING
                                           : RIL.GECKO_RADIOSTATE_DISABLING);
      radioInterface.workerMessenger.send("setRadioEnabled", message.data,
                                          (function(response) {
        if (response.errorMsg) {
          // Request fails. Rollback to the original radioState.
          this.notifyRadioStateChanged(clientId,
                                       enabled ? RIL.GECKO_RADIOSTATE_DISABLED
                                               : RIL.GECKO_RADIOSTATE_ENABLED);
        }
        message.callback(response);
        return false;
      }).bind(this));
    },

    _deactivateDataCalls: function() {
      if (DEBUG) debug("RadioControl: deactivating data calls...");
      _deactivatingDeferred = {};

      let promise = Promise.resolve();
      for (let i = 0, N = _ril.numRadioInterfaces; i < N; ++i) {
        promise = promise.then(this._deactivateDataCallsForClient(i));
      }

      return promise;
    },

    _deactivateDataCallsForClient: function(clientId) {
      return function() {
        let deferred = _deactivatingDeferred[clientId] = Promise.defer();
        let dataConnectionHandler = gDataConnectionManager.getConnectionHandler(clientId);
        dataConnectionHandler.deactivateDataCalls();
        return deferred.promise;
      };
    },

    _createTimer: function() {
      if (!_timer) {
        _timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      }
      _timer.initWithCallback(this._executeRequest.bind(this),
                              RADIO_POWER_OFF_TIMEOUT,
                              Ci.nsITimer.TYPE_ONE_SHOT);
    },

    _cancelTimer: function() {
      if (_timer) {
        _timer.cancel();
      }
    },

    _executeRequest: function() {
      if (typeof _request === "function") {
        if (DEBUG) debug("RadioControl: executeRequest");
        this._cancelTimer();
        _request();
        _request = null;
      }
      this._processNextMessage();
    },
  };
});

XPCOMUtils.defineLazyGetter(this, "gDataConnectionManager", function () {
  return {
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                           Ci.nsISettingsServiceCallback]),

    _connectionHandlers: null,

    // Flag to determine the data state to start with when we boot up. It
    // corresponds to the 'ril.data.enabled' setting from the UI.
    _dataEnabled: false,

    // Flag to record the default client id for data call. It corresponds to
    // the 'ril.data.defaultServiceId' setting from the UI.
    _dataDefaultClientId: -1,

    // Flag to record the current default client id for data call.
    // It differs from _dataDefaultClientId in that it is set only when
    // the switch of client id process is done.
    _currentDataClientId: -1,

    // Pending function to execute when we are notified that another data call has
    // been disconnected.
    _pendingDataCallRequest: null,

    debug: function(s) {
      dump("-*- DataConnectionManager: " + s + "\n");
    },

    init: function(ril) {
      if (!ril) {
        return;
      }

      this._connectionHandlers = [];
      for (let clientId = 0; clientId < ril.numRadioInterfaces; clientId++) {
        let radioInterface = ril.getRadioInterface(clientId);
        this._connectionHandlers.push(
          new DataConnectionHandler(clientId, radioInterface));
      }

      let lock = gSettingsService.createLock();
      // Read the APN data from the settings DB.
      lock.get("ril.data.apnSettings", this);
      // Read the data enabled setting from DB.
      lock.get("ril.data.enabled", this);
      lock.get("ril.data.roaming_enabled", this);
      // Read the default client id for data call.
      lock.get("ril.data.defaultServiceId", this);

      Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
      Services.obs.addObserver(this, kMozSettingsChangedObserverTopic, false);
    },

    getConnectionHandler: function(clientId) {
      return this._connectionHandlers[clientId];
    },

    isSwitchingDataClientId: function() {
      return this._pendingDataCallRequest !== null;
    },

    notifyDataCallStateChange: function(clientId) {
      if (!this.isSwitchingDataClientId() ||
          clientId != this._currentDataClientId) {
        return;
      }

      let connHandler = this._connectionHandlers[this._currentDataClientId];
      if (connHandler.allDataDisconnected() &&
          typeof this._pendingDataCallRequest === "function") {
        if (DEBUG) {
          this.debug("All data calls disconnected, process pending data settings.");
        }
        this._pendingDataCallRequest();
        this._pendingDataCallRequest = null;
      }
    },

    _handleDataClientIdChange: function(newDefault) {
      if (this._dataDefaultClientId === newDefault) {
         return;
      }
      this._dataDefaultClientId = newDefault;

      // This is to handle boot up stage.
      if (this._currentDataClientId == -1) {
        this._currentDataClientId = this._dataDefaultClientId;
        let connHandler = this._connectionHandlers[this._currentDataClientId];
        let radioInterface = connHandler.radioInterface;
        if (RILQUIRKS_DATA_REGISTRATION_ON_DEMAND ||
            RILQUIRKS_SUBSCRIPTION_CONTROL) {
          radioInterface.setDataRegistration(true);
        }
        if (this._dataEnabled) {
          let settings = connHandler.dataCallSettings;
          settings.oldEnabled = settings.enabled;
          settings.enabled = true;
          connHandler.updateRILNetworkInterface();
        }
        return;
      }

      let oldConnHandler = this._connectionHandlers[this._currentDataClientId];
      let oldIface = oldConnHandler.radioInterface;
      let oldSettings = oldConnHandler.dataCallSettings;
      let newConnHandler = this._connectionHandlers[this._dataDefaultClientId];
      let newIface = newConnHandler.radioInterface;
      let newSettings = newConnHandler.dataCallSettings;

      let applyPendingDataSettings = (function() {
        if (RILQUIRKS_DATA_REGISTRATION_ON_DEMAND ||
            RILQUIRKS_SUBSCRIPTION_CONTROL) {
          oldIface.setDataRegistration(false)
            .then(() => {
              if (this._dataEnabled) {
                newSettings.oldEnabled = newSettings.enabled;
                newSettings.enabled = true;
              }
              this._currentDataClientId = this._dataDefaultClientId;
              return newIface.setDataRegistration(true);
            })
            .then(() => newConnHandler.updateRILNetworkInterface());
          return;
        }

        if (this._dataEnabled) {
          newSettings.oldEnabled = newSettings.enabled;
          newSettings.enabled = true;
        }
        this._currentDataClientId = this._dataDefaultClientId;
        newConnHandler.updateRILNetworkInterface();
      }).bind(this);

      if (this._dataEnabled) {
        oldSettings.oldEnabled = oldSettings.enabled;
        oldSettings.enabled = false;
      }

      if (oldConnHandler.anyDataConnected()) {
        this._pendingDataCallRequest = applyPendingDataSettings;
        if (DEBUG) {
          this.debug("_handleDataClientIdChange: existing data call(s) active" +
                     ", wait for them to get disconnected.");
        }
        oldConnHandler.deactivateDataCalls();
        return;
      }

      applyPendingDataSettings();
    },

    _shutdown: function() {
      for (let handler of this._connectionHandlers) {
        handler.shutdown();
      }
      this._connectionHandlers = null;
      Services.obs.removeObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
      Services.obs.removeObserver(this, kMozSettingsChangedObserverTopic);
    },

    /**
     * nsISettingsServiceCallback
     */
    handle: function(name, result) {
      switch(name) {
        case "ril.data.apnSettings":
          if (DEBUG) {
            this.debug("'ril.data.apnSettings' is now " +
                       JSON.stringify(result));
          }
          if (!result) {
            break;
          }
          for (let clientId in this._connectionHandlers) {
            let handler = this._connectionHandlers[clientId];
            let apnSetting = result[clientId];
            if (handler && apnSetting) {
              handler.updateApnSettings(apnSetting);
              handler.updateRILNetworkInterface();
            }
          }
          break;
        case "ril.data.enabled":
          if (DEBUG) {
            this.debug("'ril.data.enabled' is now " + result);
          }
          if (this._dataEnabled === result) {
            break;
          }
          this._dataEnabled = result;

          if (DEBUG) {
            this.debug("Default id for data call: " + this._dataDefaultClientId);
          }
          if (this._dataDefaultClientId === -1) {
            // We haven't got the default id for data from db.
            break;
          }

          let connHandler = this._connectionHandlers[this._dataDefaultClientId];
          let settings = connHandler.dataCallSettings;
          settings.oldEnabled = settings.enabled;
          settings.enabled = result;
          connHandler.updateRILNetworkInterface();
          break;
        case "ril.data.roaming_enabled":
          if (DEBUG) {
            this.debug("'ril.data.roaming_enabled' is now " + result);
            this.debug("Default id for data call: " + this._dataDefaultClientId);
          }
          for (let clientId = 0; clientId < this._connectionHandlers.length; clientId++) {
            let connHandler = this._connectionHandlers[clientId];
            let settings = connHandler.dataCallSettings;
            settings.roamingEnabled = Array.isArray(result) ? result[clientId] : result;
          }
          if (this._dataDefaultClientId === -1) {
            // We haven't got the default id for data from db.
            break;
          }
          this._connectionHandlers[this._dataDefaultClientId].updateRILNetworkInterface();
          break;
        case "ril.data.defaultServiceId":
          result = result || 0;
          if (DEBUG) {
            this.debug("'ril.data.defaultServiceId' is now " + result);
          }
          this._handleDataClientIdChange(result);
          break;
      }
    },

    handleError: function(errorMessage) {
      if (DEBUG) {
        this.debug("There was an error while reading RIL settings.");
      }
    },

    /**
     * nsIObserver interface methods.
     */
    observe: function(subject, topic, data) {
      switch (topic) {
        case kMozSettingsChangedObserverTopic:
          if ("wrappedJSObject" in subject) {
            subject = subject.wrappedJSObject;
          }
          this.handle(subject.key, subject.value);
          break;
        case NS_XPCOM_SHUTDOWN_OBSERVER_ID:
          this._shutdown();
          break;
      }
    },
  };
});

// Initialize shared preference "ril.numRadioInterfaces" according to system
// property.
try {
  Services.prefs.setIntPref(kPrefRilNumRadioInterfaces, (function() {
    // When Gonk property "ro.moz.ril.numclients" is not set, return 1; if
    // explicitly set to any number larger-equal than 0, return num; else, return
    // 1 for compatibility.
    try {
      let numString = libcutils.property_get("ro.moz.ril.numclients", "1");
      let num = parseInt(numString, 10);
      if (num >= 0) {
        return num;
      }
    } catch (e) {}

    return 1;
  })());
} catch (e) {}

function IccInfo() {}
IccInfo.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIIccInfo]),

  // nsIIccInfo

  iccType: null,
  iccid: null,
  mcc: null,
  mnc: null,
  spn: null,
  isDisplayNetworkNameRequired: null,
  isDisplaySpnRequired: null
};

function GsmIccInfo() {}
GsmIccInfo.prototype = {
  __proto__: IccInfo.prototype,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIGsmIccInfo,
                                         Ci.nsIIccInfo]),

  // nsIGsmIccInfo

  msisdn: null
};

function CdmaIccInfo() {}
CdmaIccInfo.prototype = {
  __proto__: IccInfo.prototype,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsICdmaIccInfo,
                                         Ci.nsIIccInfo]),

  // nsICdmaIccInfo

  mdn: null,
  prlVersion: 0
};

function NeighboringCellInfo() {}
NeighboringCellInfo.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsINeighboringCellInfo]),
  classID:        NEIGHBORINGCELLINFO_CID,
  classInfo:      XPCOMUtils.generateCI({
    classID:          NEIGHBORINGCELLINFO_CID,
    classDescription: "NeighboringCellInfo",
    interfaces:       [Ci.nsINeighboringCellInfo]
  }),

  // nsINeighboringCellInfo

  networkType: null,
  gsmLocationAreaCode: -1,
  gsmCellId: -1,
  wcdmaPsc: -1,
  signalStrength: UNKNOWN_RSSI
};

function CellInfo() {}
CellInfo.prototype = {
  type: null,
  registered: false,
  timestampType: Ci.nsICellInfo.TIMESTAMP_TYPE_UNKNOWN,
  timestamp: 0
};

function GsmCellInfo() {}
GsmCellInfo.prototype = {
  __proto__: CellInfo.prototype,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIGsmCellInfo]),
  classID: GSMCELLINFO_CID,
  classInfo: XPCOMUtils.generateCI({
    classID:          GSMCELLINFO_CID,
    classDescription: "GsmCellInfo",
    interfaces:       [Ci.nsIGsmCellInfo]
  }),

  // nsIGsmCellInfo

  mcc: INT32_MAX,
  mnc: INT32_MAX,
  lac: INT32_MAX,
  cid: INT32_MAX,
  signalStrength: UNKNOWN_RSSI,
  bitErrorRate: UNKNOWN_RSSI
};

function WcdmaCellInfo() {}
WcdmaCellInfo.prototype = {
  __proto__: CellInfo.prototype,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWcdmaCellInfo]),
  classID: WCDMACELLINFO_CID,
  classInfo: XPCOMUtils.generateCI({
    classID:          WCDMACELLINFO_CID,
    classDescription: "WcdmaCellInfo",
    interfaces:       [Ci.nsIWcdmaCellInfo]
  }),

  // nsIWcdmaCellInfo

  mcc: INT32_MAX,
  mnc: INT32_MAX,
  lac: INT32_MAX,
  cid: INT32_MAX,
  psc: INT32_MAX,
  signalStrength: UNKNOWN_RSSI,
  bitErrorRate: UNKNOWN_RSSI
};

function LteCellInfo() {}
LteCellInfo.prototype = {
  __proto__: CellInfo.prototype,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsILteCellInfo]),
  classID: LTECELLINFO_CID,
  classInfo: XPCOMUtils.generateCI({
    classID:          LTECELLINFO_CID,
    classDescription: "LteCellInfo",
    interfaces:       [Ci.nsILteCellInfo]
  }),

  // nsILteCellInfo

  mcc: INT32_MAX,
  mnc: INT32_MAX,
  cid: INT32_MAX,
  pcid: INT32_MAX,
  tac: INT32_MAX,
  signalStrength: UNKNOWN_RSSI,
  rsrp: INT32_MAX,
  rsrq: INT32_MAX,
  rssnr: INT32_MAX,
  cqi: INT32_MAX,
  timingAdvance: INT32_MAX
};

function CdmaCellInfo() {}
CdmaCellInfo.prototype = {
  __proto__: CellInfo.prototype,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsICdmaCellInfo]),
  classID: CDMACELLINFO_CID,
  classInfo: XPCOMUtils.generateCI({
    classID:          CDMACELLINFO_CID,
    classDescription: "CdmaCellInfo",
    interfaces:       [Ci.nsICdmaCellInfo]
  }),

  // nsICdmaCellInfo

  networkId: INT32_MAX,
  systemId: INT32_MAX,
  baseStationId: INT32_MAX,
  longitude: INT32_MAX,
  latitude: INT32_MAX,
  cdmaDbm: INT32_MAX,
  cdmaEcio: INT32_MAX,
  evdoDbm: INT32_MAX,
  evdoEcio: INT32_MAX,
  evdoSnr: INT32_MAX
};

function DataConnectionHandler(clientId, radioInterface) {
  // Initial owning attributes.
  this.clientId = clientId;
  this.radioInterface = radioInterface;
  this.dataCallSettings = {
    oldEnabled: false,
    enabled: false,
    roamingEnabled: false
  };
  this._dataCalls = [];

  // This map is used to collect all the apn types and its corresponding
  // RILNetworkInterface.
  this.dataNetworkInterfaces = new Map();
}
DataConnectionHandler.prototype = {
  clientId: 0,
  radioInterface: null,
  // Data calls setting.
  dataCallSettings: null,
  dataNetworkInterfaces: null,
  _dataCalls: null,

  // Apn settings to be setup after data call are cleared.
  _pendingApnSettings: null,

  debug: function(s) {
    dump("-*- DataConnectionHandler[" + this.clientId + "]: " + s + "\n");
  },

  shutdown: function() {
    // Shutdown all RIL network interfaces
    this.dataNetworkInterfaces.forEach(function(networkInterface) {
      gNetworkManager.unregisterNetworkInterface(networkInterface);
      networkInterface.shutdown();
      networkInterface = null;
    });
    this.dataNetworkInterfaces.clear();
    this._dataCalls = [];
    this.clientId = null;
    this.radioInterface = null;
  },

  /**
   * Check if we get all necessary APN data.
   */
  _validateApnSetting: function(apnSetting) {
    return (apnSetting &&
            apnSetting.apn &&
            apnSetting.types &&
            apnSetting.types.length);
  },

  _convertApnType: function(apnType) {
    switch(apnType) {
      case "default":
        return Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE;
      case "mms":
        return Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_MMS;
      case "supl":
        return Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_SUPL;
      case "ims":
        return Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_IMS;
      case "dun":
        return Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_DUN;
      default:
        return Ci.nsINetworkInterface.NETWORK_TYPE_UNKNOWN;
     }
  },

  _compareDataCallOptions: function(dataCall, newDataCall) {
    return dataCall.apnProfile.apn == newDataCall.apn &&
           dataCall.apnProfile.user == newDataCall.user &&
           dataCall.apnProfile.password == newDataCall.passwd &&
           dataCall.chappap == newDataCall.chappap &&
           dataCall.pdptype == newDataCall.pdptype;
  },

  _deliverDataCallMessage: function(name, args) {
    for (let i = 0; i < this._dataCalls.length; i++) {
      let datacall = this._dataCalls[i];
      // Send message only to the DataCall that matches the data call options.
      // Currently, args always contain only one datacall info.
      if (!this._compareDataCallOptions(datacall, args[0])) {
        continue;
      }
      // Do not deliver message to DataCall that contains cid but mistmaches
      // with the cid in the current message.
      if (args[0].cid !== undefined && datacall.linkInfo.cid != null &&
          args[0].cid != datacall.linkInfo.cid) {
        continue;
      }

      try {
        let handler = datacall[name];
        if (typeof handler !== "function") {
          throw new Error("No handler for " + name);
        }
        handler.apply(datacall, args);
      } catch (e) {
        if (DEBUG) {
          this.debug("Handler for " + name + " threw an exception: " + e);
        }
      }
    }
  },

  /**
   * This function will do the following steps:
   *   1. Clear the cached APN settings in the RIL.
   *   2. Combine APN, user name, and password as the key of |byApn| object to
   *      refer to the corresponding APN setting.
   *   3. Use APN type as the index of |byType| object to refer to the
   *      corresponding APN setting.
   *   4. Create RilNetworkInterface for each APN setting created at step 2.
   */
  _setupApnSettings: function(newApnSettings) {
    if (!newApnSettings) {
      return;
    }
    if (DEBUG) this.debug("setupApnSettings: " + JSON.stringify(newApnSettings));

    // Shutdown all network interfaces and clear data calls.
    this.dataNetworkInterfaces.forEach(function(networkInterface) {
      gNetworkManager.unregisterNetworkInterface(networkInterface);
      networkInterface.shutdown();
      networkInterface = null;
    });
    this.dataNetworkInterfaces.clear();
    this._dataCalls = [];

    // Cache the APN settings by APNs and by types in the RIL.
    for (let inputApnSetting of newApnSettings) {
      if (!this._validateApnSetting(inputApnSetting)) {
        continue;
      }

      // Use APN type as the key of dataNetworkInterfaces to refer to the
      // corresponding RILNetworkInterface.
      for (let i = 0; i < inputApnSetting.types.length; i++) {
        let apnType = inputApnSetting.types[i];
        let networkType = this._convertApnType(apnType);
        if (networkType === Ci.nsINetworkInterface.NETWORK_TYPE_UNKNOWN) {
          if (DEBUG) this.debug("Invalid apn type: " + apnType);
          continue;
        }

        if (DEBUG) this.debug("Preparing RILNetworkInterface for type: " + apnType);
        // Create DataCall for RILNetworkInterface or reuse one that is shareable.
        let dataCall;
        for (let i = 0; i < this._dataCalls.length; i++) {
          if (this._dataCalls[i].canHandleApn(inputApnSetting)) {
            if (DEBUG) this.debug("Found shareable DataCall, reusing it.");
            dataCall = this._dataCalls[i];
            break;
          }
        }

        if (!dataCall) {
          if (DEBUG) this.debug("No shareable DataCall found, creating one.");
          dataCall = new DataCall(this.clientId, inputApnSetting);
          this._dataCalls.push(dataCall);
        }

        try {
          let networkInterface = new RILNetworkInterface(this, networkType,
                                                         inputApnSetting,
                                                         dataCall);
          gNetworkManager.registerNetworkInterface(networkInterface);
          this.dataNetworkInterfaces.set(apnType, networkInterface);
        } catch (e) {
          if (DEBUG) {
            this.debug("Error setting up RILNetworkInterface for type " +
                        apnType + ": " + e);
          }
        }
      }
    }
  },

  /**
   * Check if all data is disconnected.
   */
  allDataDisconnected: function() {
    for (let i = 0; i < this._dataCalls.length; i++) {
      let dataCall = this._dataCalls[i];
      if (dataCall.state != RIL.GECKO_NETWORK_STATE_UNKNOWN &&
          dataCall.state != RIL.GECKO_NETWORK_STATE_DISCONNECTED) {
        return false;
      }
    }
    return true;
  },

  /**
   * Check if there is any activated data connection.
   */
  anyDataConnected: function() {
    for (let i = 0; i < this._dataCalls.length; i++) {
      if (this._dataCalls[i].state == RIL.GECKO_NETWORK_STATE_CONNECTED) {
        return true;
      }
    }
    return false;
  },

  updateApnSettings: function(newApnSettings) {
    if (!newApnSettings) {
      return;
    }
    if (this._pendingApnSettings) {
      // Change of apn settings in process, just update to the newest.
      this._pengingApnSettings = newApnSettings;
      return;
    }

    let isDeactivatingDataCalls = false;
    this.dataNetworkInterfaces.forEach(function(networkInterface) {
      // Clear all existing connections.
      if (networkInterface.state == RIL.GECKO_NETWORK_STATE_CONNECTED) {
        networkInterface.disconnect();
        isDeactivatingDataCalls = true;
      }
    });

    if (isDeactivatingDataCalls) {
      // Defer apn settings setup until all data calls are cleared.
      this._pendingApnSettings = newApnSettings;
      return;
    }
    this._setupApnSettings(newApnSettings);
  },

  updateRILNetworkInterface: function() {
    let networkInterface = this.dataNetworkInterfaces.get("default");
    if (!networkInterface) {
      if (DEBUG) {
        this.debug("No network interface for default data.");
      }
      return;
    }

    let connection =
      gMobileConnectionService.getItemByServiceId(this.clientId);

    // This check avoids data call connection if the radio is not ready
    // yet after toggling off airplane mode.
    let radioState = connection && connection.radioState;
    if (radioState != RIL.GECKO_RADIOSTATE_ENABLED) {
      if (DEBUG) {
        this.debug("RIL is not ready for data connection: radio's not ready");
      }
      return;
    }

    // We only watch at "ril.data.enabled" flag changes for connecting or
    // disconnecting the data call. If the value of "ril.data.enabled" is
    // true and any of the remaining flags change the setting application
    // should turn this flag to false and then to true in order to reload
    // the new values and reconnect the data call.
    if (this.dataCallSettings.oldEnabled === this.dataCallSettings.enabled) {
      if (DEBUG) {
        this.debug("No changes for ril.data.enabled flag. Nothing to do.");
      }
      return;
    }

    let dataInfo = connection && connection.data;
    let isRegistered =
      dataInfo &&
      dataInfo.state == RIL.GECKO_MOBILE_CONNECTION_STATE_REGISTERED;
    let haveDataConnection =
      dataInfo &&
      dataInfo.type != RIL.GECKO_MOBILE_CONNECTION_STATE_UNKNOWN;
    if (!isRegistered || !haveDataConnection) {
      if (DEBUG) {
        this.debug("RIL is not ready for data connection: Phone's not " +
                   "registered or doesn't have data connection.");
      }
      return;
    }
    let wifi_active = false;
    if (gNetworkManager.active &&
        gNetworkManager.active.type == Ci.nsINetworkInterface.NETWORK_TYPE_WIFI) {
      wifi_active = true;
    }

    let defaultDataCallConnected = networkInterface.connected;

    // We have moved part of the decision making into DataCall, the rest will be
    // moved after Bug 904514 - [meta] NetworkManager enhancement.
    if (networkInterface.enabled &&
        (!this.dataCallSettings.enabled ||
         (dataInfo.roaming && !this.dataCallSettings.roamingEnabled))) {
      if (DEBUG) {
        this.debug("Data call settings: disconnect data call.");
      }
      networkInterface.disconnect();
      return;
    }

    if (networkInterface.enabled && wifi_active) {
      if (DEBUG) {
        this.debug("Disconnect data call when Wifi is connected.");
      }
      networkInterface.disconnect();
      return;
    }

    if (!this.dataCallSettings.enabled || defaultDataCallConnected) {
      if (DEBUG) {
        this.debug("Data call settings: nothing to do.");
      }
      return;
    }
    if (dataInfo.roaming && !this.dataCallSettings.roamingEnabled) {
      if (DEBUG) {
        this.debug("We're roaming, but data roaming is disabled.");
      }
      return;
    }
    if (wifi_active) {
      if (DEBUG) {
        this.debug("Don't connect data call when Wifi is connected.");
      }
      return;
    }
    if (this._pendingApnSettings) {
      if (DEBUG) this.debug("We're changing apn settings, ignore any changes.");
      return;
    }

    if (gRadioEnabledController.isDeactivatingDataCalls()) {
      // We're changing the radio power currently, ignore any changes.
      return;
    }

    if (DEBUG) {
      this.debug("Data call settings: connect data call.");
    }
    networkInterface.connect();
  },

  getDataCallStateByType: function(apnType) {
    let networkInterface = this.dataNetworkInterfaces.get(apnType);
    if (!networkInterface) {
      return RIL.GECKO_NETWORK_STATE_UNKNOWN;
    }
    return networkInterface.state;
  },

  setupDataCallByType: function(apnType) {
    if (DEBUG) {
      this.debug("setupDataCallByType: " + apnType);
    }
    let networkInterface = this.dataNetworkInterfaces.get(apnType);
    if (!networkInterface) {
      if (DEBUG) {
        this.debug("No network interface for type: " + apnType);
      }
      return;
    }

    networkInterface.connect();
  },

  deactivateDataCallByType: function(apnType) {
    if (DEBUG) {
      this.debug("deactivateDataCallByType: " + apnType);
    }
    let networkInterface = this.dataNetworkInterfaces.get(apnType);
    if (!networkInterface) {
      if (DEBUG) {
        this.debug("No network interface for type: " + apnType);
      }
      return;
    }

    networkInterface.disconnect();
  },

  deactivateDataCalls: function() {
    let dataDisconnecting = false;
    this.dataNetworkInterfaces.forEach(function(networkInterface) {
      if (networkInterface.state == RIL.GECKO_NETWORK_STATE_CONNECTED) {
        networkInterface.disconnect();
        dataDisconnecting = true;
      }
    });

    // No data calls exist. It's safe to proceed the pending radio power off
    // request.
    if (gRadioEnabledController.isDeactivatingDataCalls() && !dataDisconnecting) {
      gRadioEnabledController.finishDeactivatingDataCalls(this.clientId);
    }
  },

  /**
   * Handle data errors.
   */
  handleDataCallError: function(message) {
    // Notify data call error only for data APN
    let networkInterface = this.dataNetworkInterfaces.get("default");
    if (networkInterface && networkInterface.enabled) {
      let dataCall = networkInterface.dataCall;
      // If there is a cid, compare cid; otherwise it is probably an error on
      // data call setup.
      if (message.cid !== undefined) {
        if (message.cid == dataCall.linkInfo.cid) {
          gMobileConnectionService.notifyDataError(this.clientId, message);
        }
      } else {
        if (this._compareDataCallOptions(dataCall, message)) {
          gMobileConnectionService.notifyDataError(this.clientId, message);
        }
      }
    }

    this._deliverDataCallMessage("dataCallError", [message]);
  },

  /**
   * Handle data call state changes.
   */
  handleDataCallState: function(datacall) {
    this._deliverDataCallMessage("dataCallStateChanged", [datacall]);

    // Process pending radio power off request after all data calls
    // are disconnected.
    if (datacall.state == RIL.GECKO_NETWORK_STATE_DISCONNECTED &&
        this.allDataDisconnected()) {
      if (gRadioEnabledController.isDeactivatingDataCalls()) {
        if (DEBUG) {
          this.debug("All data connections are disconnected.");
        }
        gRadioEnabledController.finishDeactivatingDataCalls(this.clientId);
      }

      if (this._pendingApnSettings) {
        if (DEBUG) {
          this.debug("Setup pending apn settings.");
        }
        this._setupApnSettings(this._pendingApnSettings);
        this._pendingApnSettings = null;
        this.updateRILNetworkInterface();
      }

      if (gDataConnectionManager.isSwitchingDataClientId()) {
        gDataConnectionManager.notifyDataCallStateChange(this.clientId);
      }
    }
  },
};

function RadioInterfaceLayer() {
  let workerMessenger = new WorkerMessenger();
  workerMessenger.init();
  this.setWorkerDebugFlag = workerMessenger.setDebugFlag.bind(workerMessenger);

  let numIfaces = this.numRadioInterfaces;
  if (DEBUG) debug(numIfaces + " interfaces");
  this.radioInterfaces = [];
  for (let clientId = 0; clientId < numIfaces; clientId++) {
    this.radioInterfaces.push(new RadioInterface(clientId, workerMessenger));
  }

  Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
  Services.prefs.addObserver(kPrefRilDebuggingEnabled, this, false);

  gMessageManager.init(this);
  gRadioEnabledController.init(this);
  gDataConnectionManager.init(this);
}
RadioInterfaceLayer.prototype = {

  classID:   RADIOINTERFACELAYER_CID,
  classInfo: XPCOMUtils.generateCI({classID: RADIOINTERFACELAYER_CID,
                                    classDescription: "RadioInterfaceLayer",
                                    interfaces: [Ci.nsIRadioInterfaceLayer]}),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIRadioInterfaceLayer,
                                         Ci.nsIObserver]),

  /**
   * nsIObserver interface methods.
   */

  observe: function(subject, topic, data) {
    switch (topic) {
      case NS_XPCOM_SHUTDOWN_OBSERVER_ID:
        for (let radioInterface of this.radioInterfaces) {
          radioInterface.shutdown();
        }
        this.radioInterfaces = null;
        Services.obs.removeObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
        break;

      case NS_PREFBRANCH_PREFCHANGE_TOPIC_ID:
        if (data === kPrefRilDebuggingEnabled) {
          updateDebugFlag();
          this.setWorkerDebugFlag(DEBUG);
        }
        break;
    }
  },

  /**
   * nsIRadioInterfaceLayer interface methods.
   */

  getRadioInterface: function(clientId) {
    return this.radioInterfaces[clientId];
  },

  getClientIdForEmergencyCall: function() {
    for (let cid = 0; cid < this.numRadioInterfaces; ++cid) {
      if (gRadioEnabledController._isRadioAbleToEnableAtClient(cid)) {
        return cid;
      }
    }
    return -1;
  },

  setMicrophoneMuted: function(muted) {
    for (let clientId = 0; clientId < this.numRadioInterfaces; clientId++) {
      let radioInterface = this.radioInterfaces[clientId];
      radioInterface.workerMessenger.send("setMute", { muted: muted });
    }
  }
};

XPCOMUtils.defineLazyGetter(RadioInterfaceLayer.prototype,
                            "numRadioInterfaces", function() {
  try {
    return Services.prefs.getIntPref(kPrefRilNumRadioInterfaces);
  } catch(e) {}

  return 1;
});

function WorkerMessenger() {
  // Initial owning attributes.
  this.radioInterfaces = [];
  this.tokenCallbackMap = {};

  this.worker = new ChromeWorker("resource://gre/modules/ril_worker.js");
  this.worker.onerror = this.onerror.bind(this);
  this.worker.onmessage = this.onmessage.bind(this);
}
WorkerMessenger.prototype = {
  radioInterfaces: null,
  worker: null,

  // This gets incremented each time we send out a message.
  token: 1,

  // Maps tokens we send out with messages to the message callback.
  tokenCallbackMap: null,

  init: function() {
    let options = {
      debug: DEBUG,
      quirks: {
        callstateExtraUint32:
          libcutils.property_get("ro.moz.ril.callstate_extra_int", "false") === "true",
        v5Legacy:
          libcutils.property_get("ro.moz.ril.v5_legacy", "true") === "true",
        requestUseDialEmergencyCall:
          libcutils.property_get("ro.moz.ril.dial_emergency_call", "false") === "true",
        simAppStateExtraFields:
          libcutils.property_get("ro.moz.ril.simstate_extra_field", "false") === "true",
        extraUint2ndCall:
          libcutils.property_get("ro.moz.ril.extra_int_2nd_call", "false") == "true",
        haveQueryIccLockRetryCount:
          libcutils.property_get("ro.moz.ril.query_icc_count", "false") == "true",
        sendStkProfileDownload:
          libcutils.property_get("ro.moz.ril.send_stk_profile_dl", "false") == "true",
        dataRegistrationOnDemand: RILQUIRKS_DATA_REGISTRATION_ON_DEMAND,
        subscriptionControl: RILQUIRKS_SUBSCRIPTION_CONTROL
      }
    };

    this.send(null, "setInitialOptions", options);
  },

  setDebugFlag: function(aDebug) {
    let options = { debug: aDebug };
    this.send(null, "setDebugFlag", options);
  },

  debug: function(aClientId, aMessage) {
    // We use the same debug subject with RadioInterface's here.
    dump("-*- RadioInterface[" + aClientId + "]: " + aMessage + "\n");
  },

  onerror: function(event) {
    if (DEBUG) {
      this.debug("X", "Got an error: " + event.filename + ":" +
                 event.lineno + ": " + event.message + "\n");
    }
    event.preventDefault();
  },

  /**
   * Process the incoming message from the RIL worker.
   */
  onmessage: function(event) {
    let message = event.data;
    let clientId = message.rilMessageClientId;
    if (clientId === null) {
      return;
    }

    if (DEBUG) {
      this.debug(clientId, "Received message from worker: " + JSON.stringify(message));
    }

    let token = message.rilMessageToken;
    if (token == null) {
      // That's an unsolicited message.  Pass to RadioInterface directly.
      let radioInterface = this.radioInterfaces[clientId];
      radioInterface.handleUnsolicitedWorkerMessage(message);
      return;
    }

    let callback = this.tokenCallbackMap[message.rilMessageToken];
    if (!callback) {
      if (DEBUG) this.debug(clientId, "Ignore orphan token: " + message.rilMessageToken);
      return;
    }

    let keep = false;
    try {
      keep = callback(message);
    } catch(e) {
      if (DEBUG) this.debug(clientId, "callback throws an exception: " + e);
    }

    if (!keep) {
      delete this.tokenCallbackMap[message.rilMessageToken];
    }
  },

  registerClient: function(aClientId, aRadioInterface) {
    if (DEBUG) this.debug(aClientId, "Starting RIL Worker");

    // Keep a reference so that we can dispatch unsolicited messages to it.
    this.radioInterfaces[aClientId] = aRadioInterface;

    this.send(null, "registerClient", { clientId: aClientId });
    gSystemWorkerManager.registerRilWorker(aClientId, this.worker);
  },

  /**
   * Send arbitrary message to worker.
   *
   * @param rilMessageType
   *        A text message type.
   * @param message [optional]
   *        An optional message object to send.
   * @param callback [optional]
   *        An optional callback function which is called when worker replies
   *        with an message containing a "rilMessageToken" attribute of the
   *        same value we passed.  This callback function accepts only one
   *        parameter -- the reply from worker.  It also returns a boolean
   *        value true to keep current token-callback mapping and wait for
   *        another worker reply, or false to remove the mapping.
   */
  send: function(clientId, rilMessageType, message, callback) {
    message = message || {};

    message.rilMessageClientId = clientId;
    message.rilMessageToken = this.token;
    this.token++;

    if (callback) {
      // Only create the map if callback is provided.  For sending a request
      // and intentionally leaving the callback undefined, that reply will
      // be dropped in |this.onmessage| because of that orphan token.
      //
      // For sending a request that never replied at all, we're fine with this
      // because no callback shall be passed and we leave nothing to be cleaned
      // up later.
      this.tokenCallbackMap[message.rilMessageToken] = callback;
    }

    message.rilMessageType = rilMessageType;
    this.worker.postMessage(message);
  },

  /**
   * Send message to worker and return worker reply to RILContentHelper.
   *
   * @param msg
   *        A message object from ppmm.
   * @param rilMessageType
   *        A text string for worker message type.
   * @param ipcType [optinal]
   *        A text string for ipc message type. "msg.name" if omitted.
   *
   * @TODO: Bug 815526 - deprecate RILContentHelper.
   */
  sendWithIPCMessage: function(clientId, msg, rilMessageType, ipcType) {
    this.send(clientId, rilMessageType, msg.json.data, (function(reply) {
      ipcType = ipcType || msg.name;
      msg.target.sendAsyncMessage(ipcType, {
        clientId: clientId,
        data: reply
      });
      return false;
    }).bind(this));
  }
};

function RadioInterface(aClientId, aWorkerMessenger) {
  this.clientId = aClientId;
  this.workerMessenger = {
    send: aWorkerMessenger.send.bind(aWorkerMessenger, aClientId),
    sendWithIPCMessage:
      aWorkerMessenger.sendWithIPCMessage.bind(aWorkerMessenger, aClientId),
  };
  aWorkerMessenger.registerClient(aClientId, this);

  this.rilContext = {
    cardState:      Ci.nsIIccProvider.CARD_STATE_UNKNOWN,
    iccInfo:        null,
    imsi:           null
  };

  this.operatorInfo = {};

  let lock = gSettingsService.createLock();

  // Read the "time.clock.automatic-update.enabled" setting to see if
  // we need to adjust the system clock time by NITZ or SNTP.
  lock.get(kSettingsClockAutoUpdateEnabled, this);

  // Read the "time.timezone.automatic-update.enabled" setting to see if
  // we need to adjust the system timezone by NITZ.
  lock.get(kSettingsTimezoneAutoUpdateEnabled, this);

  // Set "time.clock.automatic-update.available" to false when starting up.
  this.setClockAutoUpdateAvailable(false);

  // Set "time.timezone.automatic-update.available" to false when starting up.
  this.setTimezoneAutoUpdateAvailable(false);

  Services.obs.addObserver(this, kMozSettingsChangedObserverTopic, false);
  Services.obs.addObserver(this, kSysClockChangeObserverTopic, false);
  Services.obs.addObserver(this, kScreenStateChangedTopic, false);

  Services.obs.addObserver(this, kNetworkConnStateChangedTopic, false);

  this.portAddressedSmsApps = {};
  this.portAddressedSmsApps[WAP.WDP_PORT_PUSH] = this.handleSmsWdpPortPush.bind(this);

  this._receivedSmsSegmentsMap = {};

  this._sntp = new Sntp(this.setClockBySntp.bind(this),
                        Services.prefs.getIntPref("network.sntp.maxRetryCount"),
                        Services.prefs.getIntPref("network.sntp.refreshPeriod"),
                        Services.prefs.getIntPref("network.sntp.timeout"),
                        Services.prefs.getCharPref("network.sntp.pools").split(";"),
                        Services.prefs.getIntPref("network.sntp.port"));
}

RadioInterface.prototype = {

  classID:   RADIOINTERFACE_CID,
  classInfo: XPCOMUtils.generateCI({classID: RADIOINTERFACE_CID,
                                    classDescription: "RadioInterface",
                                    interfaces: [Ci.nsIRadioInterface]}),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIRadioInterface,
                                         Ci.nsIObserver,
                                         Ci.nsISettingsServiceCallback]),

  // A private wrapped WorkerMessenger instance.
  workerMessenger: null,

  debug: function(s) {
    dump("-*- RadioInterface[" + this.clientId + "]: " + s + "\n");
  },

  shutdown: function() {
    // Release the CPU wake lock for handling the received SMS.
    this._releaseSmsHandledWakeLock();

    Services.obs.removeObserver(this, kMozSettingsChangedObserverTopic);
    Services.obs.removeObserver(this, kSysClockChangeObserverTopic);
    Services.obs.removeObserver(this, kScreenStateChangedTopic);
    Services.obs.removeObserver(this, kNetworkConnStateChangedTopic);
  },

  /**
   * A utility function to copy objects. The srcInfo may contain
   * "rilMessageType", should ignore it.
   */
  updateInfo: function(srcInfo, destInfo) {
    for (let key in srcInfo) {
      if (key === "rilMessageType") {
        continue;
      }
      destInfo[key] = srcInfo[key];
    }
  },

  /**
   * A utility function to compare objects. The srcInfo may contain
   * "rilMessageType", should ignore it.
   */
  isInfoChanged: function(srcInfo, destInfo) {
    if (!destInfo) {
      return true;
    }

    for (let key in srcInfo) {
      if (key === "rilMessageType") {
        continue;
      }
      if (srcInfo[key] !== destInfo[key]) {
        return true;
      }
    }

    return false;
  },

  /**
   * Process a message from the content process.
   */
  receiveMessage: function(msg) {
    switch (msg.name) {
      case "RIL:GetRilContext":
        // This message is sync.
        return this.rilContext;
      case "RIL:GetCardLockState":
        this.workerMessenger.sendWithIPCMessage(msg, "iccGetCardLockState",
                                                "RIL:CardLockResult");
        break;
      case "RIL:UnlockCardLock":
        this.workerMessenger.sendWithIPCMessage(msg, "iccUnlockCardLock",
                                                "RIL:CardLockResult");
        break;
      case "RIL:SetCardLock":
        this.workerMessenger.sendWithIPCMessage(msg, "iccSetCardLock",
                                                "RIL:CardLockResult");
        break;
      case "RIL:GetCardLockRetryCount":
        this.workerMessenger.sendWithIPCMessage(msg, "iccGetCardLockRetryCount",
                                                "RIL:CardLockRetryCount");
        break;
      case "RIL:SendStkResponse":
        this.workerMessenger.send("sendStkTerminalResponse", msg.json.data);
        break;
      case "RIL:SendStkMenuSelection":
        this.workerMessenger.send("sendStkMenuSelection", msg.json.data);
        break;
      case "RIL:SendStkTimerExpiration":
        this.workerMessenger.send("sendStkTimerExpiration", msg.json.data);
        break;
      case "RIL:SendStkEventDownload":
        this.workerMessenger.send("sendStkEventDownload", msg.json.data);
        break;
      case "RIL:IccOpenChannel":
        this.workerMessenger.sendWithIPCMessage(msg, "iccOpenChannel");
        break;
      case "RIL:IccCloseChannel":
        this.workerMessenger.sendWithIPCMessage(msg, "iccCloseChannel");
        break;
      case "RIL:IccExchangeAPDU":
        this.workerMessenger.sendWithIPCMessage(msg, "iccExchangeAPDU");
        break;
      case "RIL:ReadIccContacts":
        this.workerMessenger.sendWithIPCMessage(msg, "readICCContacts");
        break;
      case "RIL:UpdateIccContact":
        this.workerMessenger.sendWithIPCMessage(msg, "updateICCContact");
        break;
      case "RIL:MatchMvno":
        this.matchMvno(msg.target, msg.json.data);
        break;
    }
    return null;
  },

  handleUnsolicitedWorkerMessage: function(message) {
    let connHandler = gDataConnectionManager.getConnectionHandler(this.clientId);
    switch (message.rilMessageType) {
      case "audioStateChanged":
        gTelephonyService.notifyAudioStateChanged(this.clientId, message.state);
        break;
      case "callRing":
        gTelephonyService.notifyCallRing();
        break;
      case "callStateChange":
        gTelephonyService.notifyCallStateChanged(this.clientId, message.call);
        break;
      case "callDisconnected":
        gTelephonyService.notifyCallDisconnected(this.clientId, message.call);
        break;
      case "conferenceCallStateChanged":
        gTelephonyService.notifyConferenceCallStateChanged(message.state);
        break;
      case "cdmaCallWaiting":
        gTelephonyService.notifyCdmaCallWaiting(this.clientId,
                                                message.waitingCall);
        break;
      case "suppSvcNotification":
        gTelephonyService.notifySupplementaryService(this.clientId,
                                                     message.callIndex,
                                                     message.notification);
        break;
      case "ussdreceived":
        gTelephonyService.notifyUssdReceived(this.clientId, message.message,
                                             message.sessionEnded);
        break;
      case "datacallerror":
        connHandler.handleDataCallError(message);
        break;
      case "datacallstatechange":
        let addresses = [];
        for (let i = 0; i < message.addresses.length; i++) {
          let [address, prefixLength] = message.addresses[i].split("/");
          // From AOSP hardware/ril/include/telephony/ril.h, that address prefix
          // is said to be OPTIONAL, but we never met such case before.
          addresses.push({
            address: address,
            prefixLength: prefixLength ? parseInt(prefixLength, 10) : 0
          });
        }
        message.addresses = addresses;
        connHandler.handleDataCallState(message);
        break;
      case "emergencyCbModeChange":
        gMobileConnectionService.notifyEmergencyCallbackModeChanged(this.clientId,
                                                                    message);
        break;
      case "networkinfochanged":
        gMobileConnectionService.notifyNetworkInfoChanged(this.clientId,
                                                          message);
        connHandler.updateRILNetworkInterface();
        break;
      case "networkselectionmodechange":
        gMobileConnectionService.notifyNetworkSelectModeChanged(this.clientId,
                                                                message.mode);
        break;
      case "voiceregistrationstatechange":
        gMobileConnectionService.notifyVoiceInfoChanged(this.clientId, message);
        break;
      case "dataregistrationstatechange":
        gMobileConnectionService.notifyDataInfoChanged(this.clientId, message);
        connHandler.updateRILNetworkInterface();
        break;
      case "signalstrengthchange":
        gMobileConnectionService.notifySignalStrengthChanged(this.clientId,
                                                             message);
        break;
      case "operatorchange":
        gMobileConnectionService.notifyOperatorChanged(this.clientId, message);
        break;
      case "otastatuschange":
        gMobileConnectionService.notifyOtaStatusChanged(this.clientId, message.status);
        break;
      case "radiostatechange":
        // gRadioEnabledController should know the radio state for each client,
        // so notify gRadioEnabledController here.
        gRadioEnabledController.notifyRadioStateChanged(this.clientId,
                                                        message.radioState);
        break;
      case "cardstatechange":
        this.rilContext.cardState = message.cardState;
        gRadioEnabledController.receiveCardState(this.clientId);
        gMessageManager.sendIccMessage("RIL:CardStateChanged",
                                       this.clientId, message);
        break;
      case "sms-received":
        this.handleSmsMultipart(message);
        break;
      case "cellbroadcast-received":
        this.handleCellbroadcastMessageReceived(message);
        break;
      case "nitzTime":
        this.handleNitzTime(message);
        break;
      case "iccinfochange":
        this.handleIccInfoChange(message);
        break;
      case "iccimsi":
        this.rilContext.imsi = message.imsi;
        break;
      case "iccmbdn":
        this.handleIccMbdn(message);
        break;
      case "iccmwis":
        this.handleIccMwis(message.mwi);
        break;
      case "stkcommand":
        this.handleStkProactiveCommand(message);
        break;
      case "stksessionend":
        gMessageManager.sendIccMessage("RIL:StkSessionEnd", this.clientId, null);
        break;
      case "cdma-info-rec-received":
        this.handleCdmaInformationRecords(message.records);
        break;
      default:
        throw new Error("Don't know about this message type: " +
                        message.rilMessageType);
    }
  },

  /**
   * Get phone number from iccInfo.
   *
   * If the icc card is gsm card, the phone number is in msisdn.
   * @see nsIGsmIccInfo
   *
   * Otherwise, the phone number is in mdn.
   * @see nsICdmaIccInfo
   */
  getPhoneNumber: function() {
    let iccInfo = this.rilContext.iccInfo;

    if (!iccInfo) {
      return null;
    }

    // After moving SMS code out of RadioInterfaceLayer, we could use
    // |iccInfo instanceof Ci.nsIGsmIccInfo| here.
    // TODO: Bug 873351 - B2G SMS: move SMS code out of RadioInterfaceLayer to
    //                    SmsService
    let number = (iccInfo instanceof GsmIccInfo) ? iccInfo.msisdn : iccInfo.mdn;

    // Workaround an xpconnect issue with undefined string objects.
    // See bug 808220
    if (number === undefined || number === "undefined") {
      return null;
    }

    return number;
  },

  /**
   * A utility function to get the ICC ID of the SIM card (if installed).
   */
  getIccId: function() {
    let iccInfo = this.rilContext.iccInfo;

    if (!iccInfo) {
      return null;
    }

    let iccId = iccInfo.iccid;

    // Workaround an xpconnect issue with undefined string objects.
    // See bug 808220
    if (iccId === undefined || iccId === "undefined") {
      return null;
    }

    return iccId;
  },

  // Matches the mvnoData pattern with imsi. Characters 'x' and 'X' are skipped
  // and not compared. E.g., if the mvnoData passed is '310260x10xxxxxx',
  // then the function returns true only if imsi has the same first 6 digits,
  // 8th and 9th digit.
  isImsiMatches: function(mvnoData) {
    let imsi = this.rilContext.imsi;

    // This should not be an error, but a mismatch.
    if (mvnoData.length > imsi.length) {
      return false;
    }

    for (let i = 0; i < mvnoData.length; i++) {
      let c = mvnoData[i];
      if ((c !== 'x') && (c !== 'X') && (c !== imsi[i])) {
        return false;
      }
    }
    return true;
  },

  matchMvno: function(target, message) {
    if (DEBUG) this.debug("matchMvno: " + JSON.stringify(message));

    if (!message || !message.mvnoType || !message.mvnoData) {
      message.errorMsg = RIL.GECKO_ERROR_INVALID_PARAMETER;
    }

    if (!message.errorMsg) {
      switch (message.mvnoType) {
        case "imsi":
          if (!this.rilContext.imsi) {
            message.errorMsg = RIL.GECKO_ERROR_GENERIC_FAILURE;
            break;
          }
          message.result = this.isImsiMatches(message.mvnoData);
          break;
        case "spn":
          let spn = this.rilContext.iccInfo && this.rilContext.iccInfo.spn;
          if (!spn) {
            message.errorMsg = RIL.GECKO_ERROR_GENERIC_FAILURE;
            break;
          }
          message.result = spn == message.mvnoData;
          break;
        case "gid":
          this.workerMessenger.send("getGID1", null, (function(response) {
            let gid = response.gid1;
            let mvnoDataLength = message.mvnoData.length;

            if (!gid) {
              message.errorMsg = RIL.GECKO_ERROR_GENERIC_FAILURE;
            } else if (mvnoDataLength > gid.length) {
              message.result = false;
            } else {
              message.result =
                gid.substring(0, mvnoDataLength).toLowerCase() ==
                message.mvnoData.toLowerCase();
            }

            target.sendAsyncMessage("RIL:MatchMvno", {
              clientId: this.clientId,
              data: message
            });
          }).bind(this));
          return;
        default:
          message.errorMsg = RIL.GECKO_ERROR_MODE_NOT_SUPPORTED;
      }
    }

    target.sendAsyncMessage("RIL:MatchMvno", {
      clientId: this.clientId,
      data: message
    });
  },

  setDataRegistration: function(attach) {
    let deferred = Promise.defer();
    this.workerMessenger.send("setDataRegistration",
                              {attach: attach},
                              (function(response) {
      // Always resolve to proceed with the following steps.
      deferred.resolve(response.errorMsg ? response.errorMsg : null);
    }).bind(this));

    return deferred.promise;
  },

  /**
   * TODO: Bug 911713 - B2G NetworkManager: Move policy control logic to
   *                    NetworkManager
   */
  updateRILNetworkInterface: function() {
    let connHandler = gDataConnectionManager.getConnectionHandler(this.clientId);
    connHandler.updateRILNetworkInterface();
  },

  /**
   * Handle WDP port push PDU. Constructor WDP bearer information and deliver
   * to WapPushManager.
   *
   * @param message
   *        A SMS message.
   */
  handleSmsWdpPortPush: function(message) {
    if (message.encoding != RIL.PDU_DCS_MSG_CODING_8BITS_ALPHABET) {
      if (DEBUG) {
        this.debug("Got port addressed SMS but not encoded in 8-bit alphabet." +
                   " Drop!");
      }
      return;
    }

    let options = {
      bearer: WAP.WDP_BEARER_GSM_SMS_GSM_MSISDN,
      sourceAddress: message.sender,
      sourcePort: message.originatorPort,
      destinationAddress: this.rilContext.iccInfo.msisdn,
      destinationPort: message.destinationPort,
      serviceId: this.clientId
    };
    WAP.WapPushManager.receiveWdpPDU(message.fullData, message.fullData.length,
                                     0, options);
  },

  /**
   * A helper to broadcast the system message to launch registered apps
   * like Costcontrol, Notification and Message app... etc.
   *
   * @param aName
   *        The system message name.
   * @param aDomMessage
   *        The nsIDOMMozSmsMessage object.
   */
  broadcastSmsSystemMessage: function(aName, aDomMessage) {
    if (DEBUG) this.debug("Broadcasting the SMS system message: " + aName);

    // Sadly we cannot directly broadcast the aDomMessage object
    // because the system message mechamism will rewrap the object
    // based on the content window, which needs to know the properties.
    gSystemMessenger.broadcastMessage(aName, {
      iccId:             aDomMessage.iccId,
      type:              aDomMessage.type,
      id:                aDomMessage.id,
      threadId:          aDomMessage.threadId,
      delivery:          aDomMessage.delivery,
      deliveryStatus:    aDomMessage.deliveryStatus,
      sender:            aDomMessage.sender,
      receiver:          aDomMessage.receiver,
      body:              aDomMessage.body,
      messageClass:      aDomMessage.messageClass,
      timestamp:         aDomMessage.timestamp,
      sentTimestamp:     aDomMessage.sentTimestamp,
      deliveryTimestamp: aDomMessage.deliveryTimestamp,
      read:              aDomMessage.read
    });
  },

  // The following attributes/functions are used for acquiring/releasing the
  // CPU wake lock when the RIL handles the received SMS. Note that we need
  // a timer to bound the lock's life cycle to avoid exhausting the battery.
  _smsHandledWakeLock: null,
  _smsHandledWakeLockTimer: null,

  _acquireSmsHandledWakeLock: function() {
    if (!this._smsHandledWakeLock) {
      if (DEBUG) this.debug("Acquiring a CPU wake lock for handling SMS.");
      this._smsHandledWakeLock = gPowerManagerService.newWakeLock("cpu");
    }
    if (!this._smsHandledWakeLockTimer) {
      if (DEBUG) this.debug("Creating a timer for releasing the CPU wake lock.");
      this._smsHandledWakeLockTimer =
        Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    }
    if (DEBUG) this.debug("Setting the timer for releasing the CPU wake lock.");
    this._smsHandledWakeLockTimer
        .initWithCallback(this._releaseSmsHandledWakeLock.bind(this),
                          SMS_HANDLED_WAKELOCK_TIMEOUT,
                          Ci.nsITimer.TYPE_ONE_SHOT);
  },

  _releaseSmsHandledWakeLock: function() {
    if (DEBUG) this.debug("Releasing the CPU wake lock for handling SMS.");
    if (this._smsHandledWakeLockTimer) {
      this._smsHandledWakeLockTimer.cancel();
    }
    if (this._smsHandledWakeLock) {
      this._smsHandledWakeLock.unlock();
      this._smsHandledWakeLock = null;
    }
  },

  /**
   * Hash map for received multipart sms fragments. Messages are hashed with
   * its sender address and concatenation reference number. Three additional
   * attributes `segmentMaxSeq`, `receivedSegments`, `segments` are inserted.
   */
  _receivedSmsSegmentsMap: null,

  /**
   * Helper for processing received multipart SMS.
   *
   * @return null for handled segments, and an object containing full message
   *         body/data once all segments are received.
   */
  _processReceivedSmsSegment: function(aSegment) {

    // Directly replace full message body for single SMS.
    if (!(aSegment.segmentMaxSeq && (aSegment.segmentMaxSeq > 1))) {
      if (aSegment.encoding == RIL.PDU_DCS_MSG_CODING_8BITS_ALPHABET) {
        aSegment.fullData = aSegment.data;
      } else {
        aSegment.fullBody = aSegment.body;
      }
      return aSegment;
    }

    // Handle Concatenation for Class 0 SMS
    let hash = aSegment.sender + ":" +
               aSegment.segmentRef + ":" +
               aSegment.segmentMaxSeq;
    let seq = aSegment.segmentSeq;

    let options = this._receivedSmsSegmentsMap[hash];
    if (!options) {
      options = aSegment;
      this._receivedSmsSegmentsMap[hash] = options;

      options.receivedSegments = 0;
      options.segments = [];
    } else if (options.segments[seq]) {
      // Duplicated segment?
      if (DEBUG) {
        this.debug("Got duplicated segment no." + seq +
                           " of a multipart SMS: " + JSON.stringify(aSegment));
      }
      return null;
    }

    if (options.receivedSegments > 0) {
      // Update received timestamp.
      options.timestamp = aSegment.timestamp;
    }

    if (options.encoding == RIL.PDU_DCS_MSG_CODING_8BITS_ALPHABET) {
      options.segments[seq] = aSegment.data;
    } else {
      options.segments[seq] = aSegment.body;
    }
    options.receivedSegments++;

    // The port information is only available in 1st segment for CDMA WAP Push.
    // If the segments of a WAP Push are not received in sequence
    // (e.g., SMS with seq == 1 is not the 1st segment received by the device),
    // we have to retrieve the port information from 1st segment and
    // save it into the cached options.
    if (aSegment.teleservice === RIL.PDU_CDMA_MSG_TELESERIVCIE_ID_WAP
        && seq === 1) {
      if (!options.originatorPort && aSegment.originatorPort) {
        options.originatorPort = aSegment.originatorPort;
      }

      if (!options.destinationPort && aSegment.destinationPort) {
        options.destinationPort = aSegment.destinationPort;
      }
    }

    if (options.receivedSegments < options.segmentMaxSeq) {
      if (DEBUG) {
        this.debug("Got segment no." + seq + " of a multipart SMS: " +
                           JSON.stringify(options));
      }
      return null;
    }

    // Remove from map
    delete this._receivedSmsSegmentsMap[hash];

    // Rebuild full body
    if (options.encoding == RIL.PDU_DCS_MSG_CODING_8BITS_ALPHABET) {
      // Uint8Array doesn't have `concat`, so we have to merge all segements
      // by hand.
      let fullDataLen = 0;
      for (let i = 1; i <= options.segmentMaxSeq; i++) {
        fullDataLen += options.segments[i].length;
      }

      options.fullData = new Uint8Array(fullDataLen);
      for (let d= 0, i = 1; i <= options.segmentMaxSeq; i++) {
        let data = options.segments[i];
        for (let j = 0; j < data.length; j++) {
          options.fullData[d++] = data[j];
        }
      }
    } else {
      options.fullBody = options.segments.join("");
    }

    // Remove handy fields after completing the concatenation.
    delete options.receivedSegments;
    delete options.segments;

    if (DEBUG) {
      this.debug("Got full multipart SMS: " + JSON.stringify(options));
    }

    return options;
  },

  /**
   * Helper to create Savable SmsSegment.
   */
  _createSavableSmsSegment: function(aMessage) {
    // We precisely define what data fields to be stored into
    // DB here for better data migration.
    let segment = {};
    segment.messageType = aMessage.messageType;
    segment.teleservice = aMessage.teleservice;
    segment.SMSC = aMessage.SMSC;
    segment.sentTimestamp = aMessage.sentTimestamp;
    segment.timestamp = Date.now();
    segment.sender = aMessage.sender;
    segment.pid = aMessage.pid;
    segment.encoding = aMessage.encoding;
    segment.messageClass = aMessage.messageClass;
    segment.iccId = this.getIccId();
    if (aMessage.header) {
      segment.segmentRef = aMessage.header.segmentRef;
      segment.segmentSeq = aMessage.header.segmentSeq;
      segment.segmentMaxSeq = aMessage.header.segmentMaxSeq;
      segment.originatorPort = aMessage.header.originatorPort;
      segment.destinationPort = aMessage.header.destinationPort;
    }
    segment.mwiPresent = (aMessage.mwi)? true: false;
    segment.mwiDiscard = (segment.mwiPresent)? aMessage.mwi.discard: false;
    segment.mwiMsgCount = (segment.mwiPresent)? aMessage.mwi.msgCount: 0;
    segment.mwiActive = (segment.mwiPresent)? aMessage.mwi.active: false;
    segment.serviceCategory = aMessage.serviceCategory;
    segment.language = aMessage.language;
    segment.data = aMessage.data;
    segment.body = aMessage.body;

    return segment;
  },

  /**
   * Helper to purge complete message.
   *
   * We remove unnessary fields defined in _createSavableSmsSegment() after
   * completing the concatenation.
   */
  _purgeCompleteSmsMessage: function(aMessage) {
    // Purge concatenation info
    delete aMessage.segmentRef;
    delete aMessage.segmentSeq;
    delete aMessage.segmentMaxSeq;

    // Purge partial message body
    delete aMessage.data;
    delete aMessage.body;
  },

  /**
   * handle concatenation of received SMS.
   */
  handleSmsMultipart: function(aMessage) {
    if (DEBUG) this.debug("handleSmsMultipart: " + JSON.stringify(aMessage));

    this._acquireSmsHandledWakeLock();

    let segment = this._createSavableSmsSegment(aMessage);

    let isMultipart = (segment.segmentMaxSeq && (segment.segmentMaxSeq > 1));
    let messageClass = segment.messageClass;

    let handleReceivedAndAck = function(aRvOfIncompleteMsg, aCompleteMessage) {
      if (aCompleteMessage) {
        this._purgeCompleteSmsMessage(aCompleteMessage);
        if (this.handleSmsReceived(aCompleteMessage)) {
          this.sendAckSms(Cr.NS_OK, aCompleteMessage);
        }
        // else Ack will be sent after further process in handleSmsReceived.
      } else {
        this.sendAckSms(aRvOfIncompleteMsg, segment);
      }
    }.bind(this);

    // No need to access SmsSegmentStore for Class 0 SMS and Single SMS.
    if (!isMultipart ||
        (messageClass == RIL.GECKO_SMS_MESSAGE_CLASSES[RIL.PDU_DCS_MSG_CLASS_0])) {
      // `When a mobile terminated message is class 0 and the MS has the
      // capability of displaying short messages, the MS shall display the
      // message immediately and send an acknowledgement to the SC when the
      // message has successfully reached the MS irrespective of whether
      // there is memory available in the (U)SIM or ME. The message shall
      // not be automatically stored in the (U)SIM or ME.`
      // ~ 3GPP 23.038 clause 4

      handleReceivedAndAck(Cr.NS_OK,  // ACK OK For Incomplete Class 0
                           this._processReceivedSmsSegment(segment));
    } else {
      gMobileMessageDatabaseService
        .saveSmsSegment(segment, function notifyResult(aRv, aCompleteMessage) {
        handleReceivedAndAck(aRv,  // Ack according to the result after saving
                             aCompleteMessage);
      });
    }
  },

  portAddressedSmsApps: null,
  handleSmsReceived: function(message) {
    if (DEBUG) this.debug("handleSmsReceived: " + JSON.stringify(message));

    if (message.messageType == RIL.PDU_CDMA_MSG_TYPE_BROADCAST) {
      this.handleCellbroadcastMessageReceived(message);
      return true;
    }

    // Dispatch to registered handler if application port addressing is
    // available. Note that the destination port can possibly be zero when
    // representing a UDP/TCP port.
    if (message.destinationPort != null) {
      let handler = this.portAddressedSmsApps[message.destinationPort];
      if (handler) {
        handler(message);
      }
      return true;
    }

    if (message.encoding == RIL.PDU_DCS_MSG_CODING_8BITS_ALPHABET) {
      // Don't know how to handle binary data yet.
      return true;
    }

    message.type = "sms";
    message.sender = message.sender || null;
    message.receiver = this.getPhoneNumber();
    message.body = message.fullBody = message.fullBody || null;

    if (gSmsService.isSilentNumber(message.sender)) {
      message.id = -1;
      message.threadId = 0;
      message.delivery = DOM_MOBILE_MESSAGE_DELIVERY_RECEIVED;
      message.deliveryStatus = RIL.GECKO_SMS_DELIVERY_STATUS_SUCCESS;
      message.read = false;

      let domMessage =
        gMobileMessageService.createSmsMessage(message.id,
                                               message.threadId,
                                               message.iccId,
                                               message.delivery,
                                               message.deliveryStatus,
                                               message.sender,
                                               message.receiver,
                                               message.body,
                                               message.messageClass,
                                               message.timestamp,
                                               message.sentTimestamp,
                                               0,
                                               message.read);

      Services.obs.notifyObservers(domMessage,
                                   kSilentSmsReceivedObserverTopic,
                                   null);
      return true;
    }

    if (message.mwiPresent) {
      let mwi = {
        discard: message.mwiDiscard,
        msgCount: message.mwiMsgCount,
        active: message.mwiActive
      };
      this.workerMessenger.send("updateMwis", { mwi: mwi });

      mwi.returnNumber = message.sender;
      mwi.returnMessage = message.fullBody;
      this.handleIccMwis(mwi);

      // Dicarded MWI comes without text body.
      // Hence, we discard it here after notifying the MWI status.
      if (message.mwiDiscard) {
        return true;
      }
    }

    let notifyReceived = function notifyReceived(rv, domMessage) {
      let success = Components.isSuccessCode(rv);

      this.sendAckSms(rv, message);

      if (!success) {
        // At this point we could send a message to content to notify the user
        // that storing an incoming SMS failed, most likely due to a full disk.
        if (DEBUG) {
          this.debug("Could not store SMS, error code " + rv);
        }
        return;
      }

      this.broadcastSmsSystemMessage(kSmsReceivedObserverTopic, domMessage);
      Services.obs.notifyObservers(domMessage, kSmsReceivedObserverTopic, null);
    }.bind(this);

    if (message.messageClass != RIL.GECKO_SMS_MESSAGE_CLASSES[RIL.PDU_DCS_MSG_CLASS_0]) {
      gMobileMessageDatabaseService.saveReceivedMessage(message,
                                                        notifyReceived);
    } else {
      message.id = -1;
      message.threadId = 0;
      message.delivery = DOM_MOBILE_MESSAGE_DELIVERY_RECEIVED;
      message.deliveryStatus = RIL.GECKO_SMS_DELIVERY_STATUS_SUCCESS;
      message.read = false;

      let domMessage =
        gMobileMessageService.createSmsMessage(message.id,
                                               message.threadId,
                                               message.iccId,
                                               message.delivery,
                                               message.deliveryStatus,
                                               message.sender,
                                               message.receiver,
                                               message.body,
                                               message.messageClass,
                                               message.timestamp,
                                               message.sentTimestamp,
                                               0,
                                               message.read);

      notifyReceived(Cr.NS_OK, domMessage);
    }

    // SMS ACK will be sent in notifyReceived. Return false here.
    return false;
  },

  /**
   * Handle ACK response of received SMS.
   */
  sendAckSms: function(aRv, aMessage) {
    if (aMessage.messageClass === RIL.GECKO_SMS_MESSAGE_CLASSES[RIL.PDU_DCS_MSG_CLASS_2]) {
      return;
    }

    let result = RIL.PDU_FCS_OK;
    if (!Components.isSuccessCode(aRv)) {
      if (DEBUG) this.debug("Failed to handle received sms: " + aRv);
      result = (aRv === Cr.NS_ERROR_FILE_NO_DEVICE_SPACE)
                ? RIL.PDU_FCS_MEMORY_CAPACITY_EXCEEDED
                : RIL.PDU_FCS_UNSPECIFIED;
    }

    this.workerMessenger.send("ackSMS", { result: result });

  },

  /**
   * Set the setting value of "time.clock.automatic-update.available".
   */
  setClockAutoUpdateAvailable: function(value) {
    gSettingsService.createLock().set(kSettingsClockAutoUpdateAvailable, value, null);
  },

  /**
   * Set the setting value of "time.timezone.automatic-update.available".
   */
  setTimezoneAutoUpdateAvailable: function(value) {
    gSettingsService.createLock().set(kSettingsTimezoneAutoUpdateAvailable, value, null);
  },

  /**
   * Set the system clock by NITZ.
   */
  setClockByNitz: function(message) {
    // To set the system clock time. Note that there could be a time diff
    // between when the NITZ was received and when the time is actually set.
    gTimeService.set(
      message.networkTimeInMS + (Date.now() - message.receiveTimeInMS));
  },

  /**
   * Set the system time zone by NITZ.
   */
  setTimezoneByNitz: function(message) {
    // To set the sytem timezone. Note that we need to convert the time zone
    // value to a UTC repesentation string in the format of "UTC(+/-)hh:mm".
    // Ex, time zone -480 is "UTC+08:00"; time zone 630 is "UTC-10:30".
    //
    // We can unapply the DST correction if we want the raw time zone offset:
    // message.networkTimeZoneInMinutes -= message.networkDSTInMinutes;
    if (message.networkTimeZoneInMinutes != (new Date()).getTimezoneOffset()) {
      let absTimeZoneInMinutes = Math.abs(message.networkTimeZoneInMinutes);
      let timeZoneStr = "UTC";
      timeZoneStr += (message.networkTimeZoneInMinutes > 0 ? "-" : "+");
      timeZoneStr += ("0" + Math.floor(absTimeZoneInMinutes / 60)).slice(-2);
      timeZoneStr += ":";
      timeZoneStr += ("0" + absTimeZoneInMinutes % 60).slice(-2);
      gSettingsService.createLock().set("time.timezone", timeZoneStr, null);
    }
  },

  /**
   * Handle the NITZ message.
   */
  handleNitzTime: function(message) {
    // Got the NITZ info received from the ril_worker.
    this.setClockAutoUpdateAvailable(true);
    this.setTimezoneAutoUpdateAvailable(true);

    // Cache the latest NITZ message whenever receiving it.
    this._lastNitzMessage = message;

    // Set the received NITZ clock if the setting is enabled.
    if (this._clockAutoUpdateEnabled) {
      this.setClockByNitz(message);
    }
    // Set the received NITZ timezone if the setting is enabled.
    if (this._timezoneAutoUpdateEnabled) {
      this.setTimezoneByNitz(message);
    }
  },

  /**
   * Set the system clock by SNTP.
   */
  setClockBySntp: function(offset) {
    // Got the SNTP info.
    this.setClockAutoUpdateAvailable(true);
    if (!this._clockAutoUpdateEnabled) {
      return;
    }
    if (this._lastNitzMessage) {
      if (DEBUG) debug("SNTP: NITZ available, discard SNTP");
      return;
    }
    gTimeService.set(Date.now() + offset);
  },

  handleIccMbdn: function(message) {
    let service = Cc["@mozilla.org/voicemail/voicemailservice;1"]
                  .getService(Ci.nsIGonkVoicemailService);
    service.notifyInfoChanged(this.clientId, message.number, message.alphaId);
  },

  handleIccMwis: function(mwi) {
    let service = Cc["@mozilla.org/voicemail/voicemailservice;1"]
                  .getService(Ci.nsIGonkVoicemailService);
    service.notifyStatusChanged(this.clientId, mwi.active, mwi.msgCount,
                                mwi.returnNumber, mwi.returnMessage);
  },

  handleIccInfoChange: function(message) {
    let oldSpn = this.rilContext.iccInfo ? this.rilContext.iccInfo.spn : null;

    if (!message || !message.iccid) {
      // Card is not detected, clear iccInfo to null.
      this.rilContext.iccInfo = null;
    } else {
      if (!this.rilContext.iccInfo) {
        if (message.iccType === "ruim" || message.iccType === "csim") {
          this.rilContext.iccInfo = new CdmaIccInfo();
        } else if (message.iccType === "sim" || message.iccType === "usim") {
          this.rilContext.iccInfo = new GsmIccInfo();
        } else {
          this.rilContext.iccInfo = new IccInfo();
        }
      }

      if (!this.isInfoChanged(message, this.rilContext.iccInfo)) {
        return;
      }

      this.updateInfo(message, this.rilContext.iccInfo);
    }

    // RIL:IccInfoChanged corresponds to a DOM event that gets fired only
    // when iccInfo has changed.
    gMessageManager.sendIccMessage("RIL:IccInfoChanged",
                                   this.clientId,
                                   message.iccid ? message : null);

    // In bug 864489, icc related code will be move to gonk IccProvider, we may
    // need a better way to notify icc change to MobileConnectionService.
    gMobileConnectionService.notifyIccChanged(this.clientId,
                                              message.iccid || null);

    // Update lastKnownSimMcc.
    if (message.mcc) {
      try {
        Services.prefs.setCharPref("ril.lastKnownSimMcc",
                                   message.mcc.toString());
      } catch (e) {}
    }

    // Update lastKnownHomeNetwork.
    if (message.mcc && message.mnc) {
      let lastKnownHomeNetwork = message.mcc + "-" + message.mnc;
      // Append spn information if available.
      if (message.spn) {
        lastKnownHomeNetwork += "-" + message.spn;
      }

      gMobileConnectionService.notifyLastHomeNetworkChanged(this.clientId,
                                                            lastKnownHomeNetwork);
    }

    // If spn becomes available, we should check roaming again.
    if (!oldSpn && message.spn) {
      gMobileConnectionService.notifySpnAvailable(this.clientId);
    }
  },

  handleStkProactiveCommand: function(message) {
    if (DEBUG) this.debug("handleStkProactiveCommand " + JSON.stringify(message));
    let iccId = this.rilContext.iccInfo && this.rilContext.iccInfo.iccid;
    if (iccId) {
      gSystemMessenger.broadcastMessage("icc-stkcommand",
                                        {iccId: iccId,
                                         command: message});
    }
    gMessageManager.sendIccMessage("RIL:StkCommand", this.clientId, message);
  },

  _convertCbGsmGeographicalScope: function(aGeographicalScope) {
    return (aGeographicalScope != null)
      ? aGeographicalScope
      : Ci.nsICellBroadcastService.GSM_GEOGRAPHICAL_SCOPE_INVALID;
  },

  _convertCbMessageClass: function(aMessageClass) {
    let index = RIL.GECKO_SMS_MESSAGE_CLASSES.indexOf(aMessageClass);
    return (index != -1)
      ? index
      : Ci.nsICellBroadcastService.GSM_MESSAGE_CLASS_INVALID;
  },

  _convertCbEtwsWarningType: function(aWarningType) {
    return (aWarningType != null)
      ? aWarningType
      : Ci.nsICellBroadcastService.GSM_ETWS_WARNING_INVALID;
  },

  handleCellbroadcastMessageReceived: function(aMessage) {
    let etwsInfo = aMessage.etws;
    let hasEtwsInfo = etwsInfo != null;
    let serviceCategory = (aMessage.serviceCategory)
      ? aMessage.serviceCategory
      : Ci.nsICellBroadcastService.CDMA_SERVICE_CATEGORY_INVALID;

    gCellBroadcastService
      .notifyMessageReceived(this.clientId,
                             this._convertCbGsmGeographicalScope(aMessage.geographicalScope),
                             aMessage.messageCode,
                             aMessage.messageId,
                             aMessage.language,
                             aMessage.fullBody,
                             this._convertCbMessageClass(aMessage.messageClass),
                             Date.now(),
                             serviceCategory,
                             hasEtwsInfo,
                             (hasEtwsInfo)
                               ? this._convertCbEtwsWarningType(etwsInfo.warningType)
                               : Ci.nsICellBroadcastService.GSM_ETWS_WARNING_INVALID,
                             hasEtwsInfo ? etwsInfo.emergencyUserAlert : false,
                             hasEtwsInfo ? etwsInfo.popup : false);
  },

  handleCdmaInformationRecords: function(aRecords) {
    if (DEBUG) this.debug("cdma-info-rec-received: " + JSON.stringify(aRecords));

    let clientId = this.clientId;

    aRecords.forEach(function(aRecord) {
      if (aRecord.display) {
        gMobileConnectionService
          .notifyCdmaInfoRecDisplay(clientId, aRecord.display);
        return;
      }

      if (aRecord.calledNumber) {
        gMobileConnectionService
          .notifyCdmaInfoRecCalledPartyNumber(clientId,
                                              aRecord.calledNumber.type,
                                              aRecord.calledNumber.plan,
                                              aRecord.calledNumber.number,
                                              aRecord.calledNumber.pi,
                                              aRecord.calledNumber.si);
        return;
      }

      if (aRecord.callingNumber) {
        gMobileConnectionService
          .notifyCdmaInfoRecCallingPartyNumber(clientId,
                                               aRecord.callingNumber.type,
                                               aRecord.callingNumber.plan,
                                               aRecord.callingNumber.number,
                                               aRecord.callingNumber.pi,
                                               aRecord.callingNumber.si);
        return;
      }

      if (aRecord.connectedNumber) {
        gMobileConnectionService
          .notifyCdmaInfoRecConnectedPartyNumber(clientId,
                                                 aRecord.connectedNumber.type,
                                                 aRecord.connectedNumber.plan,
                                                 aRecord.connectedNumber.number,
                                                 aRecord.connectedNumber.pi,
                                                 aRecord.connectedNumber.si);
        return;
      }

      if (aRecord.signal) {
        gMobileConnectionService
          .notifyCdmaInfoRecSignal(clientId,
                                   aRecord.signal.type,
                                   aRecord.signal.alertPitch,
                                   aRecord.signal.signal);
        return;
      }

      if (aRecord.redirect) {
        gMobileConnectionService
          .notifyCdmaInfoRecRedirectingNumber(clientId,
                                              aRecord.redirect.type,
                                              aRecord.redirect.plan,
                                              aRecord.redirect.number,
                                              aRecord.redirect.pi,
                                              aRecord.redirect.si,
                                              aRecord.redirect.reason);
        return;
      }

      if (aRecord.lineControl) {
        gMobileConnectionService
          .notifyCdmaInfoRecLineControl(clientId,
                                        aRecord.lineControl.polarityIncluded,
                                        aRecord.lineControl.toggle,
                                        aRecord.lineControl.reverse,
                                        aRecord.lineControl.powerDenial);
        return;
      }

      if (aRecord.clirCause) {
        gMobileConnectionService
          .notifyCdmaInfoRecClir(clientId,
                                 aRecord.clirCause);
        return;
      }

      if (aRecord.audioControl) {
        gMobileConnectionService
          .notifyCdmaInfoRecAudioControl(clientId,
                                         aRecord.audioControl.upLink,
                                         aRecord.audioControl.downLink);
        return;
      }
    });
  },

  // nsIObserver

  observe: function(subject, topic, data) {
    switch (topic) {
      case kMozSettingsChangedObserverTopic:
        if ("wrappedJSObject" in subject) {
          subject = subject.wrappedJSObject;
        }
        this.handleSettingsChange(subject.key, subject.value, subject.isInternalChange);
        break;
      case kSysClockChangeObserverTopic:
        let offset = parseInt(data, 10);
        if (this._lastNitzMessage) {
          this._lastNitzMessage.receiveTimeInMS += offset;
        }
        this._sntp.updateOffset(offset);
        break;
      case kNetworkConnStateChangedTopic:
        let network = subject.QueryInterface(Ci.nsINetworkInterface);
        if (network.state != Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED) {
          return;
        }

        // SNTP can only update when we have mobile or Wifi connections.
        if (network.type != Ci.nsINetworkInterface.NETWORK_TYPE_WIFI &&
            network.type != Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE) {
          return;
        }

        // If the network comes from RIL, make sure the RIL service is matched.
        if (subject instanceof Ci.nsIRilNetworkInterface) {
          network = subject.QueryInterface(Ci.nsIRilNetworkInterface);
          if (network.serviceId != this.clientId) {
            return;
          }
        }

        // SNTP won't update unless the SNTP is already expired.
        if (this._sntp.isExpired()) {
          this._sntp.request();
        }
        break;
      case kScreenStateChangedTopic:
        this.workerMessenger.send("setScreenState", { on: (data === "on") });
        break;
    }
  },

  // Flag to determine whether to update system clock automatically. It
  // corresponds to the "time.clock.automatic-update.enabled" setting.
  _clockAutoUpdateEnabled: null,

  // Flag to determine whether to update system timezone automatically. It
  // corresponds to the "time.clock.automatic-update.enabled" setting.
  _timezoneAutoUpdateEnabled: null,

  // Remember the last NITZ message so that we can set the time based on
  // the network immediately when users enable network-based time.
  _lastNitzMessage: null,

  // Object that handles SNTP.
  _sntp: null,

  // Cell Broadcast settings values.
  _cellBroadcastSearchList: null,

  handleSettingsChange: function(aName, aResult, aIsInternalSetting) {
    // Don't allow any content processes to modify the setting
    // "time.clock.automatic-update.available" except for the chrome process.
    if (aName === kSettingsClockAutoUpdateAvailable &&
        !aIsInternalSetting) {
      let isClockAutoUpdateAvailable = this._lastNitzMessage !== null ||
                                       this._sntp.isAvailable();
      if (aResult !== isClockAutoUpdateAvailable) {
        if (DEBUG) {
          debug("Content processes cannot modify 'time.clock.automatic-update.available'. Restore!");
        }
        // Restore the setting to the current value.
        this.setClockAutoUpdateAvailable(isClockAutoUpdateAvailable);
      }
    }

    // Don't allow any content processes to modify the setting
    // "time.timezone.automatic-update.available" except for the chrome
    // process.
    if (aName === kSettingsTimezoneAutoUpdateAvailable &&
        !aIsInternalSetting) {
      let isTimezoneAutoUpdateAvailable = this._lastNitzMessage !== null;
      if (aResult !== isTimezoneAutoUpdateAvailable) {
        if (DEBUG) {
          this.debug("Content processes cannot modify 'time.timezone.automatic-update.available'. Restore!");
        }
        // Restore the setting to the current value.
        this.setTimezoneAutoUpdateAvailable(isTimezoneAutoUpdateAvailable);
      }
    }

    this.handle(aName, aResult);
  },

  // nsISettingsServiceCallback
  handle: function(aName, aResult) {
    switch(aName) {
      case kSettingsClockAutoUpdateEnabled:
        this._clockAutoUpdateEnabled = aResult;
        if (!this._clockAutoUpdateEnabled) {
          break;
        }

        // Set the latest cached NITZ time if it's available.
        if (this._lastNitzMessage) {
          this.setClockByNitz(this._lastNitzMessage);
        } else if (gNetworkManager.active && gNetworkManager.active.state ==
                 Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED) {
          // Set the latest cached SNTP time if it's available.
          if (!this._sntp.isExpired()) {
            this.setClockBySntp(this._sntp.getOffset());
          } else {
            // Or refresh the SNTP.
            this._sntp.request();
          }
        } else {
          // Set a sane minimum time.
          let buildTime = libcutils.property_get("ro.build.date.utc", "0") * 1000;
          let file = FileUtils.File("/system/b2g/b2g");
          if (file.lastModifiedTime > buildTime) {
            buildTime = file.lastModifiedTime;
          }
          if (buildTime > Date.now()) {
            gTimeService.set(buildTime);
          }
        }
        break;
      case kSettingsTimezoneAutoUpdateEnabled:
        this._timezoneAutoUpdateEnabled = aResult;

        if (this._timezoneAutoUpdateEnabled) {
          // Apply the latest cached NITZ for timezone if it's available.
          if (this._timezoneAutoUpdateEnabled && this._lastNitzMessage) {
            this.setTimezoneByNitz(this._lastNitzMessage);
          }
        }
        break;
    }
  },

  handleError: function(aErrorMessage) {
    if (DEBUG) {
      this.debug("There was an error while reading RIL settings.");
    }
  },

  // nsIRadioInterface

  rilContext: null,

  /**
   * List of tuples of national language identifier pairs.
   *
   * TODO: Support static/runtime settings, see bug 733331.
   */
  enabledGsmTableTuples: [
    [RIL.PDU_NL_IDENTIFIER_DEFAULT, RIL.PDU_NL_IDENTIFIER_DEFAULT],
  ],

  /**
   * Use 16-bit reference number for concatenated outgoint messages.
   *
   * TODO: Support static/runtime settings, see bug 733331.
   */
  segmentRef16Bit: false,

  /**
   * Get valid SMS concatenation reference number.
   */
  _segmentRef: 0,
  get nextSegmentRef() {
    let ref = this._segmentRef++;

    this._segmentRef %= (this.segmentRef16Bit ? 65535 : 255);

    // 0 is not a valid SMS concatenation reference number.
    return ref + 1;
  },

  /**
   * Calculate encoded length using specified locking/single shift table
   *
   * @param message
   *        message string to be encoded.
   * @param langTable
   *        locking shift table string.
   * @param langShiftTable
   *        single shift table string.
   * @param strict7BitEncoding
   *        Optional. Enable Latin characters replacement with corresponding
   *        ones in GSM SMS 7-bit default alphabet.
   *
   * @return encoded length in septets.
   *
   * @note that the algorithm used in this function must match exactly with
   * GsmPDUHelper#writeStringAsSeptets.
   */
  _countGsm7BitSeptets: function(message, langTable, langShiftTable, strict7BitEncoding) {
    let length = 0;
    for (let msgIndex = 0; msgIndex < message.length; msgIndex++) {
      let c = message.charAt(msgIndex);
      if (strict7BitEncoding) {
        c = RIL.GSM_SMS_STRICT_7BIT_CHARMAP[c] || c;
      }

      let septet = langTable.indexOf(c);

      // According to 3GPP TS 23.038, section 6.1.1 General notes, "The
      // characters marked '1)' are not used but are displayed as a space."
      if (septet == RIL.PDU_NL_EXTENDED_ESCAPE) {
        continue;
      }

      if (septet >= 0) {
        length++;
        continue;
      }

      septet = langShiftTable.indexOf(c);
      if (septet < 0) {
        if (!strict7BitEncoding) {
          return -1;
        }

        // Bug 816082, when strict7BitEncoding is enabled, we should replace
        // characters that can't be encoded with GSM 7-Bit alphabets with '*'.
        c = "*";
        if (langTable.indexOf(c) >= 0) {
          length++;
        } else if (langShiftTable.indexOf(c) >= 0) {
          length += 2;
        } else {
          // We can't even encode a '*' character with current configuration.
          return -1;
        }

        continue;
      }

      // According to 3GPP TS 23.038 B.2, "This code represents a control
      // character and therefore must not be used for language specific
      // characters."
      if (septet == RIL.PDU_NL_RESERVED_CONTROL) {
        continue;
      }

      // The character is not found in locking shfit table, but could be
      // encoded as <escape><char> with single shift table. Note that it's
      // still possible for septet to has the value of PDU_NL_EXTENDED_ESCAPE,
      // but we can display it as a space in this case as said in previous
      // comment.
      length += 2;
    }

    return length;
  },

  /**
   * Calculate user data length of specified message string encoded in GSM 7Bit
   * alphabets.
   *
   * @param message
   *        a message string to be encoded.
   * @param strict7BitEncoding
   *        Optional. Enable Latin characters replacement with corresponding
   *        ones in GSM SMS 7-bit default alphabet.
   *
   * @return null or an options object with attributes `dcs`,
   *         `userDataHeaderLength`, `encodedFullBodyLength`, `langIndex`,
   *         `langShiftIndex`, `segmentMaxSeq` set.
   *
   * @see #_calculateUserDataLength().
   */
  _calculateUserDataLength7Bit: function(message, strict7BitEncoding) {
    let options = null;
    let minUserDataSeptets = Number.MAX_VALUE;
    for (let i = 0; i < this.enabledGsmTableTuples.length; i++) {
      let [langIndex, langShiftIndex] = this.enabledGsmTableTuples[i];

      const langTable = RIL.PDU_NL_LOCKING_SHIFT_TABLES[langIndex];
      const langShiftTable = RIL.PDU_NL_SINGLE_SHIFT_TABLES[langShiftIndex];

      let bodySeptets = this._countGsm7BitSeptets(message,
                                                  langTable,
                                                  langShiftTable,
                                                  strict7BitEncoding);
      if (bodySeptets < 0) {
        continue;
      }

      let headerLen = 0;
      if (langIndex != RIL.PDU_NL_IDENTIFIER_DEFAULT) {
        headerLen += 3; // IEI + len + langIndex
      }
      if (langShiftIndex != RIL.PDU_NL_IDENTIFIER_DEFAULT) {
        headerLen += 3; // IEI + len + langShiftIndex
      }

      // Calculate full user data length, note the extra byte is for header len
      let headerSeptets = Math.ceil((headerLen ? headerLen + 1 : 0) * 8 / 7);
      let segmentSeptets = RIL.PDU_MAX_USER_DATA_7BIT;
      if ((bodySeptets + headerSeptets) > segmentSeptets) {
        headerLen += this.segmentRef16Bit ? 6 : 5;
        headerSeptets = Math.ceil((headerLen + 1) * 8 / 7);
        segmentSeptets -= headerSeptets;
      }

      let segments = Math.ceil(bodySeptets / segmentSeptets);
      let userDataSeptets = bodySeptets + headerSeptets * segments;
      if (userDataSeptets >= minUserDataSeptets) {
        continue;
      }

      minUserDataSeptets = userDataSeptets;

      options = {
        dcs: RIL.PDU_DCS_MSG_CODING_7BITS_ALPHABET,
        encodedFullBodyLength: bodySeptets,
        userDataHeaderLength: headerLen,
        langIndex: langIndex,
        langShiftIndex: langShiftIndex,
        segmentMaxSeq: segments,
        segmentChars: segmentSeptets,
      };
    }

    return options;
  },

  /**
   * Calculate user data length of specified message string encoded in UCS2.
   *
   * @param message
   *        a message string to be encoded.
   *
   * @return an options object with attributes `dcs`, `userDataHeaderLength`,
   *         `encodedFullBodyLength`, `segmentMaxSeq` set.
   *
   * @see #_calculateUserDataLength().
   */
  _calculateUserDataLengthUCS2: function(message) {
    let bodyChars = message.length;
    let headerLen = 0;
    let headerChars = Math.ceil((headerLen ? headerLen + 1 : 0) / 2);
    let segmentChars = RIL.PDU_MAX_USER_DATA_UCS2;
    if ((bodyChars + headerChars) > segmentChars) {
      headerLen += this.segmentRef16Bit ? 6 : 5;
      headerChars = Math.ceil((headerLen + 1) / 2);
      segmentChars -= headerChars;
    }

    let segments = Math.ceil(bodyChars / segmentChars);

    return {
      dcs: RIL.PDU_DCS_MSG_CODING_16BITS_ALPHABET,
      encodedFullBodyLength: bodyChars * 2,
      userDataHeaderLength: headerLen,
      segmentMaxSeq: segments,
      segmentChars: segmentChars,
    };
  },

  /**
   * Calculate user data length and its encoding.
   *
   * @param message
   *        a message string to be encoded.
   * @param strict7BitEncoding
   *        Optional. Enable Latin characters replacement with corresponding
   *        ones in GSM SMS 7-bit default alphabet.
   *
   * @return an options object with some or all of following attributes set:
   *
   * @param dcs
   *        Data coding scheme. One of the PDU_DCS_MSG_CODING_*BITS_ALPHABET
   *        constants.
   * @param userDataHeaderLength
   *        Length of embedded user data header, in bytes. The whole header
   *        size will be userDataHeaderLength + 1; 0 for no header.
   * @param encodedFullBodyLength
   *        Length of the message body when encoded with the given DCS. For
   *        UCS2, in bytes; for 7-bit, in septets.
   * @param langIndex
   *        Table index used for normal 7-bit encoded character lookup.
   * @param langShiftIndex
   *        Table index used for escaped 7-bit encoded character lookup.
   * @param segmentMaxSeq
   *        Max sequence number of a multi-part messages, or 1 for single one.
   *        This number might not be accurate for a multi-part message until
   *        it's processed by #_fragmentText() again.
   */
  _calculateUserDataLength: function(message, strict7BitEncoding) {
    let options = this._calculateUserDataLength7Bit(message, strict7BitEncoding);
    if (!options) {
      options = this._calculateUserDataLengthUCS2(message);
    }

    if (DEBUG) this.debug("_calculateUserDataLength: " + JSON.stringify(options));
    return options;
  },

  /**
   * Fragment GSM 7-Bit encodable string for transmission.
   *
   * @param text
   *        text string to be fragmented.
   * @param langTable
   *        locking shift table string.
   * @param langShiftTable
   *        single shift table string.
   * @param segmentSeptets
   *        Number of available spetets per segment.
   * @param strict7BitEncoding
   *        Optional. Enable Latin characters replacement with corresponding
   *        ones in GSM SMS 7-bit default alphabet.
   *
   * @return an array of objects. See #_fragmentText() for detailed definition.
   */
  _fragmentText7Bit: function(text, langTable, langShiftTable, segmentSeptets, strict7BitEncoding) {
    let ret = [];
    let body = "", len = 0;
    // If the message is empty, we only push the empty message to ret.
    if (text.length === 0) {
      ret.push({
        body: text,
        encodedBodyLength: text.length,
      });
      return ret;
    }

    for (let i = 0, inc = 0; i < text.length; i++) {
      let c = text.charAt(i);
      if (strict7BitEncoding) {
        c = RIL.GSM_SMS_STRICT_7BIT_CHARMAP[c] || c;
      }

      let septet = langTable.indexOf(c);
      if (septet == RIL.PDU_NL_EXTENDED_ESCAPE) {
        continue;
      }

      if (septet >= 0) {
        inc = 1;
      } else {
        septet = langShiftTable.indexOf(c);
        if (septet == RIL.PDU_NL_RESERVED_CONTROL) {
          continue;
        }

        inc = 2;
        if (septet < 0) {
          if (!strict7BitEncoding) {
            throw new Error("Given text cannot be encoded with GSM 7-bit Alphabet!");
          }

          // Bug 816082, when strict7BitEncoding is enabled, we should replace
          // characters that can't be encoded with GSM 7-Bit alphabets with '*'.
          c = "*";
          if (langTable.indexOf(c) >= 0) {
            inc = 1;
          }
        }
      }

      if ((len + inc) > segmentSeptets) {
        ret.push({
          body: body,
          encodedBodyLength: len,
        });
        body = c;
        len = inc;
      } else {
        body += c;
        len += inc;
      }
    }

    if (len) {
      ret.push({
        body: body,
        encodedBodyLength: len,
      });
    }

    return ret;
  },

  /**
   * Fragment UCS2 encodable string for transmission.
   *
   * @param text
   *        text string to be fragmented.
   * @param segmentChars
   *        Number of available characters per segment.
   *
   * @return an array of objects. See #_fragmentText() for detailed definition.
   */
  _fragmentTextUCS2: function(text, segmentChars) {
    let ret = [];
    // If the message is empty, we only push the empty message to ret.
    if (text.length === 0) {
      ret.push({
        body: text,
        encodedBodyLength: text.length,
      });
      return ret;
    }

    for (let offset = 0; offset < text.length; offset += segmentChars) {
      let str = text.substr(offset, segmentChars);
      ret.push({
        body: str,
        encodedBodyLength: str.length * 2,
      });
    }

    return ret;
  },

  /**
   * Fragment string for transmission.
   *
   * Fragment input text string into an array of objects that contains
   * attributes `body`, substring for this segment, `encodedBodyLength`,
   * length of the encoded segment body in septets.
   *
   * @param text
   *        Text string to be fragmented.
   * @param options
   *        Optional pre-calculated option object. The output array will be
   *        stored at options.segments if there are multiple segments.
   * @param strict7BitEncoding
   *        Optional. Enable Latin characters replacement with corresponding
   *        ones in GSM SMS 7-bit default alphabet.
   *
   * @return Populated options object.
   */
  _fragmentText: function(text, options, strict7BitEncoding) {
    if (!options) {
      options = this._calculateUserDataLength(text, strict7BitEncoding);
    }

    if (options.dcs == RIL.PDU_DCS_MSG_CODING_7BITS_ALPHABET) {
      const langTable = RIL.PDU_NL_LOCKING_SHIFT_TABLES[options.langIndex];
      const langShiftTable = RIL.PDU_NL_SINGLE_SHIFT_TABLES[options.langShiftIndex];
      options.segments = this._fragmentText7Bit(text,
                                                langTable, langShiftTable,
                                                options.segmentChars,
                                                strict7BitEncoding);
    } else {
      options.segments = this._fragmentTextUCS2(text,
                                                options.segmentChars);
    }

    // Re-sync options.segmentMaxSeq with actual length of returning array.
    options.segmentMaxSeq = options.segments.length;

    return options;
  },

  getSegmentInfoForText: function(text, request) {
    let strict7BitEncoding;
    try {
      strict7BitEncoding = Services.prefs.getBoolPref("dom.sms.strict7BitEncoding");
    } catch (e) {
      strict7BitEncoding = false;
    }

    let options = this._fragmentText(text, null, strict7BitEncoding);
    let charsInLastSegment;
    if (options.segmentMaxSeq) {
      let lastSegment = options.segments[options.segmentMaxSeq - 1];
      charsInLastSegment = lastSegment.encodedBodyLength;
      if (options.dcs == RIL.PDU_DCS_MSG_CODING_16BITS_ALPHABET) {
        // In UCS2 encoding, encodedBodyLength is in octets.
        charsInLastSegment /= 2;
      }
    } else {
      charsInLastSegment = 0;
    }

    request.notifySegmentInfoForTextGot(options.segmentMaxSeq,
                                        options.segmentChars,
                                        options.segmentChars - charsInLastSegment);
  },

  getSmscAddress: function(request) {
    this.workerMessenger.send("getSmscAddress",
                              null,
                              (function(response) {
      if (!response.errorMsg) {
        request.notifyGetSmscAddress(response.smscAddress);
      } else {
        request.notifyGetSmscAddressFailed(Ci.nsIMobileMessageCallback.NOT_FOUND_ERROR);
      }
    }).bind(this));
  },

  sendSMS: function(number, message, silent, request) {
    let strict7BitEncoding;
    try {
      strict7BitEncoding = Services.prefs.getBoolPref("dom.sms.strict7BitEncoding");
    } catch (e) {
      strict7BitEncoding = false;
    }

    let options = this._fragmentText(message, null, strict7BitEncoding);
    options.number = PhoneNumberUtils.normalize(number);
    let requestStatusReport;
    try {
      requestStatusReport =
        Services.prefs.getBoolPref("dom.sms.requestStatusReport");
    } catch (e) {
      requestStatusReport = true;
    }
    options.requestStatusReport = requestStatusReport && !silent;
    if (options.segmentMaxSeq > 1) {
      options.segmentRef16Bit = this.segmentRef16Bit;
      options.segmentRef = this.nextSegmentRef;
    }

    let notifyResult = (function notifyResult(rv, domMessage) {
      if (!Components.isSuccessCode(rv)) {
        if (DEBUG) this.debug("Error! Fail to save sending message! rv = " + rv);
        request.notifySendMessageFailed(
          gMobileMessageDatabaseService.translateCrErrorToMessageCallbackError(rv),
          domMessage);
        Services.obs.notifyObservers(domMessage, kSmsFailedObserverTopic, null);
        return;
      }

      if (!silent) {
        Services.obs.notifyObservers(domMessage, kSmsSendingObserverTopic, null);
      }

      let connection =
        gMobileConnectionService.getItemByServiceId(this.clientId);
      // If the radio is disabled or the SIM card is not ready, just directly
      // return with the corresponding error code.
      let errorCode;
      let radioState = connection && connection.radioState;
      if (!PhoneNumberUtils.isPlainPhoneNumber(options.number)) {
        if (DEBUG) this.debug("Error! Address is invalid when sending SMS: " +
                              options.number);
        errorCode = Ci.nsIMobileMessageCallback.INVALID_ADDRESS_ERROR;
      } else if (radioState == null ||
                 radioState == RIL.GECKO_RADIOSTATE_DISABLED) {
        if (DEBUG) this.debug("Error! Radio is disabled when sending SMS.");
        errorCode = Ci.nsIMobileMessageCallback.RADIO_DISABLED_ERROR;
      } else if (this.rilContext.cardState != Ci.nsIIccProvider.CARD_STATE_READY) {
        if (DEBUG) this.debug("Error! SIM card is not ready when sending SMS.");
        errorCode = Ci.nsIMobileMessageCallback.NO_SIM_CARD_ERROR;
      }
      if (errorCode) {
        if (silent) {
          request.notifySendMessageFailed(errorCode, domMessage);
          return;
        }

        gMobileMessageDatabaseService
          .setMessageDeliveryByMessageId(domMessage.id,
                                         null,
                                         DOM_MOBILE_MESSAGE_DELIVERY_ERROR,
                                         RIL.GECKO_SMS_DELIVERY_STATUS_ERROR,
                                         null,
                                         function notifyResult(rv, domMessage) {
          // TODO bug 832140 handle !Components.isSuccessCode(rv)
          request.notifySendMessageFailed(errorCode, domMessage);
          Services.obs.notifyObservers(domMessage, kSmsFailedObserverTopic, null);
        });
        return;
      }

      // Keep current SMS message info for sent/delivered notifications
      let context = {
        request: request,
        sms: domMessage,
        requestStatusReport: options.requestStatusReport,
        silent: silent
      };

      // This is the entry point starting to send SMS.
      this.workerMessenger.send("sendSMS", options,
                                (function(context, response) {
        if (response.errorMsg) {
          // Failed to send SMS out.
          let error = Ci.nsIMobileMessageCallback.UNKNOWN_ERROR;
          switch (response.errorMsg) {
            case RIL.ERROR_RADIO_NOT_AVAILABLE:
              error = Ci.nsIMobileMessageCallback.NO_SIGNAL_ERROR;
              break;
            case RIL.ERROR_FDN_CHECK_FAILURE:
              error = Ci.nsIMobileMessageCallback.FDN_CHECK_ERROR;
              break;
          }

          if (context.silent) {
            // There is no way to modify nsIDOMMozSmsMessage attributes as they
            // are read only so we just create a new sms instance to send along
            // with the notification.
            let sms = context.sms;
            context.request.notifySendMessageFailed(
              error,
              gMobileMessageService.createSmsMessage(sms.id,
                                                     sms.threadId,
                                                     sms.iccId,
                                                     DOM_MOBILE_MESSAGE_DELIVERY_ERROR,
                                                     RIL.GECKO_SMS_DELIVERY_STATUS_ERROR,
                                                     sms.sender,
                                                     sms.receiver,
                                                     sms.body,
                                                     sms.messageClass,
                                                     sms.timestamp,
                                                     0,
                                                     0,
                                                     sms.read));
            return false;
          }

          gMobileMessageDatabaseService
            .setMessageDeliveryByMessageId(context.sms.id,
                                           null,
                                           DOM_MOBILE_MESSAGE_DELIVERY_ERROR,
                                           RIL.GECKO_SMS_DELIVERY_STATUS_ERROR,
                                           null,
                                           function notifyResult(rv, domMessage) {
            // TODO bug 832140 handle !Components.isSuccessCode(rv)
            context.request.notifySendMessageFailed(error, domMessage);
            Services.obs.notifyObservers(domMessage, kSmsFailedObserverTopic, null);
          });
          return false;
        } // End of send failure.

        if (response.deliveryStatus) {
          // Message delivery.
          gMobileMessageDatabaseService
            .setMessageDeliveryByMessageId(context.sms.id,
                                           null,
                                           context.sms.delivery,
                                           response.deliveryStatus,
                                           null,
                                           (function notifyResult(rv, domMessage) {
            // TODO bug 832140 handle !Components.isSuccessCode(rv)

            let topic = (response.deliveryStatus ==
                         RIL.GECKO_SMS_DELIVERY_STATUS_SUCCESS)
                        ? kSmsDeliverySuccessObserverTopic
                        : kSmsDeliveryErrorObserverTopic;

            // Broadcasting a "sms-delivery-success" system message to open apps.
            if (topic == kSmsDeliverySuccessObserverTopic) {
              this.broadcastSmsSystemMessage(topic, domMessage);
            }

            // Notifying observers the delivery status is updated.
            Services.obs.notifyObservers(domMessage, topic, null);
          }).bind(this));

          // Send transaction has ended completely.
          return false;
        } // End of message delivery.

        // Message sent.
        if (context.silent) {
          // There is no way to modify nsIDOMMozSmsMessage attributes as they
          // are read only so we just create a new sms instance to send along
          // with the notification.
          let sms = context.sms;
          context.request.notifyMessageSent(
            gMobileMessageService.createSmsMessage(sms.id,
                                                   sms.threadId,
                                                   sms.iccId,
                                                   DOM_MOBILE_MESSAGE_DELIVERY_SENT,
                                                   sms.deliveryStatus,
                                                   sms.sender,
                                                   sms.receiver,
                                                   sms.body,
                                                   sms.messageClass,
                                                   sms.timestamp,
                                                   Date.now(),
                                                   0,
                                                   sms.read));
          // We don't wait for SMS-DELIVER-REPORT for silent one.
          return false;
        }

        gMobileMessageDatabaseService
          .setMessageDeliveryByMessageId(context.sms.id,
                                         null,
                                         DOM_MOBILE_MESSAGE_DELIVERY_SENT,
                                         context.sms.deliveryStatus,
                                         null,
                                         (function notifyResult(rv, domMessage) {
          // TODO bug 832140 handle !Components.isSuccessCode(rv)

          if (context.requestStatusReport) {
            context.sms = domMessage;
          }

          this.broadcastSmsSystemMessage(kSmsSentObserverTopic, domMessage);
          context.request.notifyMessageSent(domMessage);
          Services.obs.notifyObservers(domMessage, kSmsSentObserverTopic, null);
        }).bind(this));

        // Only keep current context if we have requested for delivery report.
        return context.requestStatusReport;
      }).bind(this, context)); // End of |workerMessenger.send| callback.
    }).bind(this); // End of DB saveSendingMessage callback.

    let sendingMessage = {
      type: "sms",
      sender: this.getPhoneNumber(),
      receiver: number,
      body: message,
      deliveryStatusRequested: options.requestStatusReport,
      timestamp: Date.now(),
      iccId: this.getIccId()
    };

    if (silent) {
      let delivery = DOM_MOBILE_MESSAGE_DELIVERY_SENDING;
      let deliveryStatus = RIL.GECKO_SMS_DELIVERY_STATUS_PENDING;
      let domMessage =
        gMobileMessageService.createSmsMessage(-1, // id
                                               0,  // threadId
                                               sendingMessage.iccId,
                                               delivery,
                                               deliveryStatus,
                                               sendingMessage.sender,
                                               sendingMessage.receiver,
                                               sendingMessage.body,
                                               "normal", // message class
                                               sendingMessage.timestamp,
                                               0,
                                               0,
                                               false);
      notifyResult(Cr.NS_OK, domMessage);
      return;
    }

    let id = gMobileMessageDatabaseService.saveSendingMessage(
      sendingMessage, notifyResult);
  },

  // TODO: Bug 928861 - B2G NetworkManager: Provide a more generic function
  //                    for connecting
  setupDataCallByType: function(apntype) {
    let connHandler = gDataConnectionManager.getConnectionHandler(this.clientId);
    connHandler.setupDataCallByType(apntype);
  },

  // TODO: Bug 928861 - B2G NetworkManager: Provide a more generic function
  //                    for connecting
  deactivateDataCallByType: function(apntype) {
    let connHandler = gDataConnectionManager.getConnectionHandler(this.clientId);
    connHandler.deactivateDataCallByType(apntype);
  },

  // TODO: Bug 904514 - [meta] NetworkManager enhancement
  getDataCallStateByType: function(apntype) {
    let connHandler = gDataConnectionManager.getConnectionHandler(this.clientId);
    return connHandler.getDataCallStateByType(apntype);
  },

  sendWorkerMessage: function(rilMessageType, message, callback) {
    // Special handler for setRadioEnabled.
    if (rilMessageType === "setRadioEnabled") {
      // Forward it to gRadioEnabledController.
      gRadioEnabledController.setRadioEnabled(this.clientId, message,
                                              callback.handleResponse);
      return;
    }

    if (callback) {
      this.workerMessenger.send(rilMessageType, message, function(response) {
        return callback.handleResponse(response);
      });
    } else {
      this.workerMessenger.send(rilMessageType, message);
    }
  },

  getCellInfoList: function(callback) {
    this.workerMessenger.send("getCellInfoList",
                              null,
                              function(response) {
      if (response.errorMsg) {
        callback.notifyGetCellInfoListFailed(response.errorMsg);
        return;
      }

      let cellInfoList = [];
      let count = response.result.length;
      for (let i = 0; i < count; i++) {
        let srcCellInfo = response.result[i];
        let cellInfo;
        switch (srcCellInfo.type) {
          case RIL.CELL_INFO_TYPE_GSM:
            cellInfo = new GsmCellInfo();
            break;
          case RIL.CELL_INFO_TYPE_WCDMA:
            cellInfo = new WcdmaCellInfo();
            break;
          case RIL.CELL_INFO_TYPE_LTE:
            cellInfo = new LteCellInfo();
            break;
          case RIL.CELL_INFO_TYPE_CDMA:
            cellInfo = new CdmaCellInfo();
            break;
        }

        if (!cellInfo) {
          continue;
        }
        this.updateInfo(srcCellInfo, cellInfo);
        cellInfoList.push(cellInfo);
      }
      callback.notifyGetCellInfoList(cellInfoList);
    }.bind(this));
  },

  getNeighboringCellIds: function(callback) {
    this.workerMessenger.send("getNeighboringCellIds",
                              null,
                              function(response) {
      if (response.errorMsg) {
        callback.notifyGetNeighboringCellIdsFailed(response.errorMsg);
        return;
      }

      let neighboringCellIds = [];
      let count = response.result.length;
      for (let i = 0; i < count; i++) {
        let srcCellInfo = response.result[i];
        let cellInfo = new NeighboringCellInfo();
        this.updateInfo(srcCellInfo, cellInfo);
        neighboringCellIds.push(cellInfo);
      }
      callback.notifyGetNeighboringCellIds(neighboringCellIds);

    }.bind(this));
  }
};

function DataCall(clientId, apnSetting) {
  this.clientId = clientId;
  this.apnProfile = {
    apn: apnSetting.apn,
    user: apnSetting.user,
    password: apnSetting.password,
    authType: apnSetting.authtype,
    protocol: apnSetting.protocol,
    roaming_protocol: apnSetting.roaming_protocol
  };
  this.linkInfo = {
    cid: null,
    ifname: null,
    ips: [],
    prefixLengths: [],
    dnses: [],
    gateways: []
  };
  this.state = RIL.GECKO_NETWORK_STATE_UNKNOWN;
  this.requestedNetworkIfaces = [];
}

DataCall.prototype = {
  /**
   * Standard values for the APN connection retry process
   * Retry funcion: time(secs) = A * numer_of_retries^2 + B
   */
  NETWORK_APNRETRY_FACTOR: 8,
  NETWORK_APNRETRY_ORIGIN: 3,
  NETWORK_APNRETRY_MAXRETRIES: 10,

  // Event timer for connection retries
  timer: null,

  // APN failed connections. Retry counter
  apnRetryCounter: 0,

  // Array to hold RILNetworkInterfaces that requested this DataCall.
  requestedNetworkIfaces: null,

  // Holds the pdp type sent to ril worker.
  pdptype: null,

  // Holds the authentication type sent to ril worker.
  chappap: null,

  dataCallError: function(message) {
    if (DEBUG) this.debug("Data call error on APN: " + message.apn);
    this.state = RIL.GECKO_NETWORK_STATE_DISCONNECTED;
    this.retry();
  },

  dataCallStateChanged: function(datacall) {
    if (DEBUG) {
      this.debug("Data call ID: " + datacall.cid + ", interface name: " +
                 datacall.ifname + ", APN name: " + datacall.apn + ", state: " +
                 datacall.state);
    }

    if (this.state == datacall.state &&
        datacall.state != RIL.GECKO_NETWORK_STATE_CONNECTED) {
      return;
    }

    switch (datacall.state) {
      case RIL.GECKO_NETWORK_STATE_CONNECTED:
        if (this.state == RIL.GECKO_NETWORK_STATE_CONNECTING) {
          this.linkInfo.cid = datacall.cid;

          if (this.requestedNetworkIfaces.length === 0) {
            if (DEBUG) {
              this.debug("State is connected, but no network interface requested" +
                         " this DataCall");
            }
            this.deactivate();
            return;
          }

          this.linkInfo.ifname = datacall.ifname;
          for (let entry of datacall.addresses) {
            this.linkInfo.ips.push(entry.address);
            this.linkInfo.prefixLengths.push(entry.prefixLength);
          }
          this.linkInfo.gateways = datacall.gateways.slice();
          this.linkInfo.dnses = datacall.dnses.slice();

        } else if (this.state == RIL.GECKO_NETWORK_STATE_CONNECTED) {
          // configuration changed.
          let changed = false;
          if (this.linkInfo.ips.length != datacall.addresses.length) {
            changed = true;
            this.linkInfo.ips = [];
            this.linkInfo.prefixLengths = [];
            for (let entry of datacall.addresses) {
              this.linkInfo.ips.push(entry.address);
              this.linkInfo.prefixLengths.push(entry.prefixLength);
            }
          }

          let reduceFunc = function(aRhs, aChanged, aElement, aIndex) {
            return aChanged || (aElement != aRhs[aIndex]);
          };
          for (let field of ["gateways", "dnses"]) {
            let lhs = this.linkInfo[field], rhs = datacall[field];
            if (lhs.length != rhs.length ||
                lhs.reduce(reduceFunc.bind(null, rhs), false)) {
              changed = true;
              this.linkInfo[field] = rhs.slice();
            }
          }
          if (!changed) {
            return;
          }
        }
        break;
      case RIL.GECKO_NETWORK_STATE_DISCONNECTED:
      case RIL.GECKO_NETWORK_STATE_UNKNOWN:
        if (this.state == RIL.GECKO_NETWORK_STATE_CONNECTED) {
          // Notify first on unexpected data call disconnection.
          this.state = datacall.state;
          for (let i = 0; i < this.requestedNetworkIfaces.length; i++) {
            this.requestedNetworkIfaces[i].notifyRILNetworkInterface();
          }
        }
        this.reset();

        if (this.requestedNetworkIfaces.length > 0) {
          if (DEBUG) {
            this.debug("State is disconnected/unknown, but this DataCall is" +
                       " requested.");
          }
          this.setup();
          return;
        }
        break;
    }

    this.state = datacall.state;
    for (let i = 0; i < this.requestedNetworkIfaces.length; i++) {
      this.requestedNetworkIfaces[i].notifyRILNetworkInterface();
    }
  },

  // Helpers

  debug: function(s) {
    dump("-*- DataCall[" + this.clientId + ":" + this.apnProfile.apn + "]: " +
      s + "\n");
  },

  get connected() {
    return this.state == RIL.GECKO_NETWORK_STATE_CONNECTED;
  },

  inRequestedTypes: function(type) {
    for (let i = 0; i < this.requestedNetworkIfaces.length; i++) {
      if (this.requestedNetworkIfaces[i].type == type) {
        return true;
      }
    }
    return false;
  },

  canHandleApn: function(apnSetting) {
    let isIdentical = this.apnProfile.apn == apnSetting.apn &&
                      (this.apnProfile.user || '') == (apnSetting.user || '') &&
                      (this.apnProfile.password || '') == (apnSetting.password || '') &&
                      (this.apnProfile.authType || '') == (apnSetting.authtype || '');

    if (RILQUIRKS_HAVE_IPV6) {
      isIdentical = isIdentical &&
                    (this.apnProfile.protocol || '') == (apnSetting.protocol || '') &&
                    (this.apnProfile.roaming_protocol || '') == (apnSetting.roaming_protocol || '');
    }

    return isIdentical;
  },

  reset: function() {
    this.linkInfo.cid = null;
    this.linkInfo.ifname = null;
    this.linkInfo.ips = [];
    this.linkInfo.prefixLengths = [];
    this.linkInfo.dnses = [];
    this.linkInfo.gateways = [];

    this.state = RIL.GECKO_NETWORK_STATE_UNKNOWN;

    this.chappap = null;
    this.pdptype = null;
  },

  connect: function(networkInterface) {
    if (DEBUG) this.debug("connect: " + networkInterface.type);

    if (this.requestedNetworkIfaces.indexOf(networkInterface) == -1) {
      this.requestedNetworkIfaces.push(networkInterface);
    }

    if (this.state == RIL.GECKO_NETWORK_STATE_CONNECTING ||
        this.state == RIL.GECKO_NETWORK_STATE_DISCONNECTING) {
      return;
    }
    if (this.state == RIL.GECKO_NETWORK_STATE_CONNECTED) {
      // This needs to run asynchronously, to behave the same way as the case of
      // non-shared apn, see bug 1059110.
      Services.tm.currentThread.dispatch(function(state) {
        // Do not notify if state changed while this event was being dispatched,
        // the state probably was notified already or need not to be notified.
        if (networkInterface.state == state) {
          networkInterface.notifyRILNetworkInterface();
        }
      }.bind(null, RIL.GECKO_NETWORK_STATE_CONNECTED), Ci.nsIEventTarget.DISPATCH_NORMAL);
      return;
    }

    // If retry mechanism is running on background, stop it since we are going
    // to setup data call now.
    if (this.timer) {
      this.timer.cancel();
    }

    this.setup();
  },

  setup: function() {
    if (DEBUG) {
      this.debug("Going to set up data connection with APN " +
                 this.apnProfile.apn);
    }

    let connection =
      gMobileConnectionService.getItemByServiceId(this.clientId);
    let dataInfo = connection && connection.data;
    if (dataInfo == null ||
        dataInfo.state != RIL.GECKO_MOBILE_CONNECTION_STATE_REGISTERED ||
        dataInfo.type == RIL.GECKO_MOBILE_CONNECTION_STATE_UNKNOWN) {
      return;
    }

    let radioTechType = dataInfo.type;
    let radioTechnology = RIL.GECKO_RADIO_TECH.indexOf(radioTechType);
    let authType = RIL.RIL_DATACALL_AUTH_TO_GECKO.indexOf(this.apnProfile.authType);
    // Use the default authType if the value in database is invalid.
    // For the case that user might not select the authentication type.
    if (authType == -1) {
      if (DEBUG) {
        this.debug("Invalid authType " + this.apnProfile.authtype);
      }
      authType = RIL.RIL_DATACALL_AUTH_TO_GECKO.indexOf(RIL.GECKO_DATACALL_AUTH_DEFAULT);
    }
    this.chappap = authType;

    let pdpType = RIL.GECKO_DATACALL_PDP_TYPE_IP;
    if (RILQUIRKS_HAVE_IPV6) {
      pdpType = !dataInfo.roaming
              ? this.apnProfile.protocol
              : this.apnProfile.roaming_protocol;
      if (RIL.RIL_DATACALL_PDP_TYPES.indexOf(pdpType) < 0) {
        if (DEBUG) {
          this.debug("Invalid pdpType '" + pdpType + "', using '" +
                     RIL.GECKO_DATACALL_PDP_TYPE_DEFAULT + "'");
        }
        pdpType = RIL.GECKO_DATACALL_PDP_TYPE_DEFAULT;
      }
    }
    this.pdptype = pdpType;

    let radioInterface = this.gRIL.getRadioInterface(this.clientId);
    radioInterface.sendWorkerMessage("setupDataCall", {
      radioTech: radioTechnology,
      apn: this.apnProfile.apn,
      user: this.apnProfile.user,
      passwd: this.apnProfile.password,
      chappap: authType,
      pdptype: pdpType
    });
    this.state = RIL.GECKO_NETWORK_STATE_CONNECTING;
  },

  retry: function() {
    let apnRetryTimer;

    // We will retry the connection in increasing times
    // based on the function: time = A * numer_of_retries^2 + B
    if (this.apnRetryCounter >= this.NETWORK_APNRETRY_MAXRETRIES) {
      this.apnRetryCounter = 0;
      this.timer = null;
      if (DEBUG) this.debug("Too many APN Connection retries - STOP retrying");
      return;
    }

    apnRetryTimer = this.NETWORK_APNRETRY_FACTOR *
                    (this.apnRetryCounter * this.apnRetryCounter) +
                    this.NETWORK_APNRETRY_ORIGIN;
    this.apnRetryCounter++;
    if (DEBUG) {
      this.debug("Data call - APN Connection Retry Timer (secs-counter): " +
                 apnRetryTimer + "-" + this.apnRetryCounter);
    }

    if (this.timer == null) {
      // Event timer for connection retries
      this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    }
    this.timer.initWithCallback(this, apnRetryTimer * 1000,
                                Ci.nsITimer.TYPE_ONE_SHOT);
  },

  disconnect: function(networkInterface) {
    if (DEBUG) this.debug("disconnect: " + networkInterface.type);
    let index = this.requestedNetworkIfaces.indexOf(networkInterface);
    if (index != -1) {
      this.requestedNetworkIfaces.splice(index, 1);

      if (this.state == RIL.GECKO_NETWORK_STATE_DISCONNECTED ||
          this.state == RIL.GECKO_NETWORK_STATE_UNKNOWN) {
        if (this.timer) {
          this.timer.cancel();
        }
        this.reset();
        return;
      }

      // Notify the DISCONNECTED event immediately after network interface is
      // removed from requestedNetworkIfaces, to make the DataCall, shared or
      // not, to have the same behavior.
      Services.tm.currentThread.dispatch(function(state) {
        // Do not notify if state changed while this event was being dispatched,
        // the state probably was notified already or need not to be notified.
        if (networkInterface.state == state) {
          networkInterface.notifyRILNetworkInterface();
        }
      }.bind(null, RIL.GECKO_NETWORK_STATE_DISCONNECTED), Ci.nsIEventTarget.DISPATCH_NORMAL);
    }

    // Only deactivate data call if no more network interface needs this
    // DataCall and if state is CONNECTED, for other states, we simply remove
    // the network interface from requestedNetworkIfaces.
    if (this.requestedNetworkIfaces.length > 0 ||
        this.state != RIL.GECKO_NETWORK_STATE_CONNECTED) {
      return;
    }

    this.deactivate();
  },

  deactivate: function() {
    let reason = RIL.DATACALL_DEACTIVATE_NO_REASON;
    if (DEBUG) {
      this.debug("Going to disconnet data connection cid " + this.linkInfo.cid);
    }
    let radioInterface = this.gRIL.getRadioInterface(this.clientId);
    radioInterface.sendWorkerMessage("deactivateDataCall", {
      cid: this.linkInfo.cid,
      reason: reason
    });
    this.state = RIL.GECKO_NETWORK_STATE_DISCONNECTING;
  },

  // Entry method for timer events. Used to reconnect to a failed APN
  notify: function(timer) {
    this.setup();
  },

  shutdown: function() {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }
};

function RILNetworkInterface(dataConnectionHandler, type, apnSetting, dataCall) {
  if (!dataCall) {
    throw new Error("No dataCall for RILNetworkInterface: " + type);
  }

  this.dataConnectionHandler = dataConnectionHandler;
  this.type = type;
  this.apnSetting = apnSetting;
  this.dataCall = dataCall;

  this.enabled = false;
}

RILNetworkInterface.prototype = {
  classID:   RILNETWORKINTERFACE_CID,
  classInfo: XPCOMUtils.generateCI({classID: RILNETWORKINTERFACE_CID,
                                    classDescription: "RILNetworkInterface",
                                    interfaces: [Ci.nsINetworkInterface,
                                                 Ci.nsIRilNetworkInterface]}),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsINetworkInterface,
                                         Ci.nsIRilNetworkInterface]),

  // Hold reference to DataCall object which is determined at initilization.
  dataCall: null,

  // If this RILNetworkInterface type is enabled or not.
  enabled: null,

  /**
   * nsINetworkInterface Implementation
   */

  get state() {
    if (!this.dataCall.inRequestedTypes(this.type)) {
      return Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
    }
    return this.dataCall.state;
  },

  type: null,

  get name() {
    return this.dataCall.linkInfo.ifname;
  },

  get httpProxyHost() {
    return this.apnSetting.proxy || "";
  },

  get httpProxyPort() {
    return this.apnSetting.port || "";
  },

  getAddresses: function(ips, prefixLengths) {
    let linkInfo = this.dataCall.linkInfo;

    ips.value = linkInfo.ips.slice();
    prefixLengths.value = linkInfo.prefixLengths.slice();

    return linkInfo.ips.length;
  },

  getGateways: function(count) {
    let linkInfo = this.dataCall.linkInfo;

    if (count) {
      count.value = linkInfo.gateways.length;
    }
    return linkInfo.gateways.slice();
  },

  getDnses: function(count) {
    let linkInfo = this.dataCall.linkInfo;

    if (count) {
      count.value = linkInfo.dnses.length;
    }
    return linkInfo.dnses.slice();
  },

  /**
   * nsIRilNetworkInterface Implementation
   */

  get serviceId() {
    return this.dataConnectionHandler.clientId;
  },

  get iccId() {
    let iccInfo = this.dataConnectionHandler.radioInterface.rilContext.iccInfo;
    return iccInfo && iccInfo.iccid;
  },

  get mmsc() {
    if (this.type != Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_MMS) {
      if (DEBUG) this.debug("Error! Only MMS network can get MMSC.");
      throw Cr.NS_ERROR_UNEXPECTED;
    }

    let mmsc = this.apnSetting.mmsc;
    if (!mmsc) {
      try {
        mmsc = Services.prefs.getCharPref("ril.mms.mmsc");
      } catch (e) {
        mmsc = "";
      }
    }

    return mmsc;
  },

  get mmsProxy() {
    if (this.type != Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_MMS) {
      if (DEBUG) this.debug("Error! Only MMS network can get MMS proxy.");
      throw Cr.NS_ERROR_UNEXPECTED;
    }

    let proxy = this.apnSetting.mmsproxy;
    if (!proxy) {
      try {
        proxy = Services.prefs.getCharPref("ril.mms.mmsproxy");
      } catch (e) {
        proxy = "";
      }
    }

    return proxy;
  },

  get mmsPort() {
    if (this.type != Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_MMS) {
      if (DEBUG) this.debug("Error! Only MMS network can get MMS port.");
      throw Cr.NS_ERROR_UNEXPECTED;
    }

    let port = this.apnSetting.mmsport;
    if (!port) {
      try {
        port = Services.prefs.getIntPref("ril.mms.mmsport");
      } catch (e) {
        port = -1;
      }
    }

    return port;
  },

  // Helpers

  debug: function(s) {
    dump("-*- RILNetworkInterface[" + this.dataConnectionHandler.clientId + ":" +
         this.type + "]: " + s + "\n");
  },

  apnSetting: null,

  get connected() {
    return this.state == Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED;
  },

  notifyRILNetworkInterface: function() {
    if (DEBUG) {
      this.debug("notifyRILNetworkInterface type: " + this.type + ", state: " +
                 this.state);
    }

    gNetworkManager.updateNetworkInterface(this);
  },

  connect: function() {
    this.enabled = true;

    this.dataCall.connect(this);
  },

  disconnect: function() {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;

    this.dataCall.disconnect(this);
  },

  shutdown: function() {
    this.dataCall.shutdown();
    this.dataCall = null;
  }

};

XPCOMUtils.defineLazyServiceGetter(DataCall.prototype, "gRIL",
                                   "@mozilla.org/ril;1",
                                   "nsIRadioInterfaceLayer");

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([RadioInterfaceLayer]);
