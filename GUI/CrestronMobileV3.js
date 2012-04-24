/* Crestron Mobile Interface
 //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

 AUTHORS:	Greg Soli, Audio Advice - Florent Pillet, CommandFusion
 CONTACT:	greg.soli@audioadvice.com
 VERSION:	v 3.0-alpha

 TODO LIST:
 - Replace join arrays by objects whose properties are the join strings themselves. Each Crestron system can then
   be configured to target only a certain range or list of joins
 - Autoconfigure the joins to support by looking at the output of CF.getGuiProperties(), and only defined those joins
   in the arrays
 /////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
 */

// Test for autoconfig
var CrestronMobileConfig_CrestronMobile = {
	// A list of pages for which we are monitoring all joins. A page name can be a regular expression
	// In a given page, joins of all elements (including elements in referenced subpages) will be processed
	pages: ["Startup"],

	// An additional list of joins we also want to handle, even though they don't match objects in defined pages
	joins: [],

	// The password to use to connect to this Crestron processor
	password: "1234"

};

var CrestronMobile = {
	// Possible states (constants) of a CrestronMobile instance
	NOT_INITIALIZED: 0,
	CONNECTING: 1,
	CONNECTED: 2,
	RESETTING: 3,
	DISCONNECTED: 4,

	// Global Variable Assignments
	debug: true,			// set to true to add CrestronMobile's own debugging messages to the log
	preloadComplete: false,
	instances: [],			// an array holding one module instance for each remote Crestron system

	//
	// Module setup function
	//
	setup:function () {
		if (CrestronMobile.debug) {
			CF.log("CrestronMobile: setup()");
		}

		// Setup unique ports if CrestronUUID was included
		try {
			CrestronUUID.setup();
		} catch (ex) {
		}

		// Global watch to enable all CrestronMobile instances when GUI preloading is complete
		CF.watch(CF.PreloadingCompleteEvent, this.onGUIPreloadComplete);

		// Detect autoconfiguration. Skip system with empty name (main control system)
		var autoconfigFound = false, associatedSystems = {};
		for (var systemName in CF.systems) {
			if (systemName !== "") {
				var autoconfigName = "CrestronMobileConfig_" + systemName;
				if (window[autoconfigName] !== undefined) {
					autoconfigFound = true;
					associatedSystems[systemName] = window[autoconfigName];
				}
			}
		}
		if (!autoconfigFound && CF.systems["CrestronMobile"] !== undefined) {
			// No auto-configuration found: use old-style compatibility, generate a fake
			// autoconfig that uses the "CrestronMobile" system and monitors all the pages
			associatedSystems["CrestronMobile"] = {
				pages: ["*"],
				joins: [],
				password: null
			}
		}

		// First get the global tokens, then the GUI description, then we can start
		// creating instances and link them to the watched joins
		CF.getJoin(CF.GlobalTokensJoin, function (j, v, globalTokens) {
			// compatibility with earlier versions: use the password in the global tokens
			var compatibilityConfig = associatedSystems["CrestronMobile"];
			if (compatibilityConfig !== undefined && compatibilityConfig.password === null) {
				associatedSystems["CrestronMobile"].password = globalTokens["cmPassword"] || "1234";
			}
			// Obtain the GUI description and perform instantiation of each CrestronMobile instance in the callback
			CF.getGuiDescription(function(guiDescription) {
				for (var sys in associatedSystems) {
					// Create a new instance
					var instance = CrestronMobile.createInstance(sys, associatedSystems[sys], guiDescription);
					CrestronMobile.instances.push(instance);
				}
			});
		});
	},

	onGUIPreloadComplete:function () {
		if (CrestronMobile.debug) {
			CF.log("CrestronMobile: GUI preload complete");
		}
		CrestronMobile.instances.forEach(function(instance) { instance.connection("connect"); });
	},

	/**
	* Create and return a new module instance
	* @param name		the name of the extern system to connect to, as defined in the GUI
	* @param config		the configuration object we use to setup watches
	* @param guiDescription the result of CF.getGuiDescription()
	*/
	createInstance: function(name, config, guiDescription) {

		var instance = {
			systemName: name,
			systemConnected: false,
			password: config.password,

			state: CrestronMobile.NOT_INITIALIZED,
			loggedIn:false,
			updateComplete: false,
			initialized: false,
			hasNetwork: false,
			guiSuspended: false,
			orientation:"2",

			heartbeatTimer: 0,
			heartbeatCount: 0,
			lastDataReceived: 0,

			connectionResetTimeout:0,
			loadingMessageVisible:false,
			loadingMessageSubpage:"d4001",

			aJoin: {},
			dJoin: {},
			sJoin: {},
			buttonRepeat: {},

			monitorGuiObjects: function(guiObjects) {
				if (guiObjects !== null) {
					var i, n;
					for (i = 0, n = guiObjects.length; i < n; i++) {
						var guiObj = guiObjects[i];
						var type = guiObj.join.charAt(0);
						if (type === 'd') {
							this.dJoin[guiObj.join] = 0;
							if (guiObj.type === "Button") {
								this.buttonRepeat[guiObj.join] = 0;
							}
						} else if (type === 'a') {
							this.aJoin[guiObj.join] = 0;
						} else if (type === 's') {
							this.sJoin[guiObj.join] = "";
						}
					}
				}
			},

			initialize: function(config, guiDescription) {
				var i, j, n, c;
				var guiPages = guiDescription.pages, numGuiPages = guiPages.length, page;
				var buttonJoins = [], analogJoins = [], serialJoins = [], digitalJoins = [];

				// gather the complete set of joins to monitor
				for (i = 0, n = config.pages.length; i < n; i++) {
					var regex = new RegExp(config.pages[i]);
					for (j = 0; j < numGuiPages; j++) {
						page = guiPages[j];
						if (page.name.match(regex)) {
							// add all joins of this page
							this.dJoin[page.join] = 0;
							this.monitorGuiObjects(page.portraitObjects);
							this.monitorGuiObjects(page.landscapeObjects);
						}
					}
				}
				// add optional joins defined in config.joins. Note that any buttons added here won't
				// be observed as repeating buttons, but simply as on/off digital joins
				if (config.joins !== undefined) {
					for (i = 0, n = config.joins.length; i < n; i++) {
						j = config.joins[i];
						c = j.charAt(0);
						if (c === 'd') {
							digitalJoins.push(j);
						} else if (c === 'a') {
							analogJoins.push(j);
						} else if (c === 's') {
							serialJoins.push(j);
						}
					}
				}
				for (j in this.dJoin) {
					if (this.buttonRepeat[j] !== undefined) {
						buttonJoins.push(j);
					} else {
						digitalJoins.push(j);
					}
				}
				for (j in this.aJoin) {
					analogJoins.push(j);
				}
				for (j in this.sJoin) {
					serialJoins.push(j);
				}

				// Disable system if preloading is not complete yet
				if (!CrestronMobile.preloadComplete) {
					this.connection("disconnect");
				}

				// Watch events. For each event, we define a lamba function whose sole purpose is to call
				// into the instance's callback, ensuring that `this' is properly set when the callback executes
				var self = this;
				CF.watch(CF.NetworkStatusChangeEvent, function(networkStatus) { self.onNetworkStatusChange(networkStatus); }, true);
				CF.watch(CF.ConnectionStatusChangeEvent, self.systemName, function(system,connected,remote) { self.onSystemConnectionChanged(system,connected,remote); });
				CF.watch(CF.FeedbackMatchedEvent, self.systemName, "Feedback", function(feedback,match) { self.processFeedback(feedback,match); });

				CF.watch(CF.ObjectPressedEvent, buttonJoins, function(j) { self.onButtonPressed(j); });
				CF.watch(CF.ObjectReleasedEvent, buttonJoins, function(j) { self.onButtonReleased(j); });
				CF.watch(CF.ObjectDraggedEvent, analogJoins, function(j,v) { self.onAnalogChanged(j,v); });
				CF.watch(CF.JoinChangeEvent, serialJoins, function(j,v,t) { self.onSerialChanged(j,v,t); });
				CF.watch(CF.JoinChangeEvent, digitalJoins, function(j,v) { self.onDigitalChanged(j,v); });

				CF.watch(CF.OrientationChangeEvent, function(page,orientation) { self.onOrientationChange(page,orientation); }, true);

				CF.watch(CF.GUISuspendedEvent, function() { self.onGUISuspended(); });
				CF.watch(CF.GUIResumedEvent, function() { self.onGUIResumed(); });

				// Setup heartneat timer
				this.heartbeatTimer = setInterval(function () {
					if (!self.guiSuspended) {
						if (self.updateComplete) {
							self.sendHeartBeat();
						} else if (self.hasNetwork && ++self.heartbeatCount > 5 && !self.loggedIn && self.connectionResetTimeout === 0) {
							if (CrestronMobile.debug) {
								CF.log("CrestronMobile: heartbeatTimer fired, not loggedIn, time to reset connection (heartbeatCount=" + self.heartbeatCount + ")");
							}
							self.heartbeatCount = 0;
							self.connection("reset");
						}
					}
				}, 2000);
			},

			resetRunningJoins: function() {
				// Reset the known values of joins
				var known;
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: resetting running joins");
				}
				for (known in this.dJoin) {
					known.value = 0;
				}
				for (known in this.aJoin) {
					known.value = 0;
				}
				for (known in this.sJoin) {
					known.value = "";
				}
			},

			setLoadingMessageVisible:function (show) {
				if (this.loadingMessageVisible !== show) {
					this.loadingMessageVisible = show;
					CF.setJoin(this.loadingMessageSubpage, show);
				}
			},

			// ------------------------------------------------------------------
			// Network events, data and connection handling
			// ------------------------------------------------------------------
			onNetworkStatusChange:function (networkStatus) {
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: networkStatus hasNetwork=" + networkStatus.hasNetwork);
				}
				this.hasNetwork = networkStatus.hasNetwork;
				if (networkStatus.hasNetwork) {
					if (CrestronMobile.preloadComplete) {
						this.connection("connect");
					}
				} else {
					this.connection("disconnect");
				}
			},

			onSystemConnectionChanged: function(system, connected, remote) {
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: system connected=" + connected + ", remote=" + remote);
				}
				this.systemConnected = connected;
				if (connected) {
					// reset heartbeatCount to give enough time for initial exchange
					this.heartbeatCount = 0;
				}
			},

			sendData: function(data) {
				CF.send(this.systemName, data, CF.UTF8);
			},

			clearConnectionResetTimeout: function() {
				if (this.connectionResetTimeout !== 0) {
					clearTimeout(this.connectionResetTimeout);
					this.connectionResetTimeout = 0;
				}
			},

			connection:function (type) {
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: connection " + type);
				}

				if (type === "reset") {
					// Reset the connection: disconnect immediately then reconnect a bit later
					if (this.state !== CrestronMobile.RESETTING) {
						this.clearConnectionResetTimeout();
						this.state = CrestronMobile.RESETTING;
						this.heartbeatCount = 0;
						this.updateComplete = false;
						this.loggedIn = false;

						CF.setSystemProperties(this.systemName, { enabled:false });

						var self = this;
						this.connectionResetTimeout = setTimeout(function () {
							if (CrestronMobile.debug) {
								CF.log("CrestronMobile: connectionResetTimeout expired, re-enabling system");
							}
							self.connectionResetTimeout = 0;
							self.heartbeatCount = 0;			// prevent timer from reseting us again too early
							CF.setSystemProperties(self.systemName, { enabled:true });
							self.state = CrestronMobile.CONNECTING;
							self.setLoadingMessageVisible(true);
						}, 500);
					}

				} else if (type === "disconnect") {
					this.clearConnectionResetTimeout();
					this.heartbeatCount = 0;
					this.setLoadingMessageVisible(false);
					this.updateComplete = false;
					this.loggedIn = false;

					CF.setSystemProperties(this.systemName, { enabled:false });

					this.state = CrestronMobile.DISCONNECTED;

				} else if (type === "connect") {
					// this won't have any impact if system is not already connecting
					if (this.state === CrestronMobile.NOT_INITIALIZED || this.state === CrestronMobile.DISCONNECTED) {
						CF.setSystemProperties(this.systemName, { enabled:true });
						this.state = CrestronMobile.CONNECTING;
					}
				}
			},

			// ------------------------------------------------------------------
			// GUI events handling
			// ------------------------------------------------------------------
			onGUISuspended:function () {
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: GUI suspended");
				}
				this.guiSuspended = true;
				this.heartbeatCount = 0;
			},

			onGUIResumed:function () {
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: GUI resumed");
				}
				this.guiSuspended = false;
				this.heartbeatCount = 0;
				this.clearConnectionResetTimeout();
			},

			onOrientationChange:function (pageName, newOrientation) {
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: orientation changed, pageName=" + pageName + ", newOrientation=" + newOrientation);
				}
				if (newOrientation === CF.LandscapeOrientation) {
					this.sendData("<cresnet><data><i32 id=\"17259\" value=\"2\"/></data></cresnet>");
					this.orientation = "2";
				} else {
					this.sendData("<cresnet><data><i32 id=\"17259\" value=\"1\"/></data></cresnet>");
					this.orientation = "1";
				}
			},

			onButtonPressed: function(join) {
				var id = join.substring(1);
				var data = "<cresnet><data><bool id=\"" + id + "\" value=\"true\" repeating=\"true\"/></data></cresnet>";
				this.sendData(data);
				var timer = this.buttonRepeat[id];
				if (timer !== 0) {
					clearInterval(timer);
					this.buttonRepeat[id] = 0;
				}
				var self = this;
				this.buttonRepeat[id] = setInterval(function () {
					self.sendData(data);
				}, 500);
			},

			onButtonReleased: function(join) {
				var id = join.substring(1);
				if (this.buttonRepeat[id] !== 0) {
					clearInterval(this.buttonRepeat[id]);
					this.buttonRepeat[id] = 0;
				}
				this.sendData("<cresnet><data><bool id=\"" + id + "\" value=\"false\" repeating=\"true\"/></data></cresnet>");
			},

			onAnalogChanged:function (join, value) {
				if (this.initialized) {
					// only transmit update if Crestron doesn't already know this value. In practice, iViewer only fires
					// join change events when the join value actually changes
					if (this.aJoin[join] !== value) {
						this.aJoin[join] = value;
						this.sendData("<cresnet><data><i32 id=\"" + join.substring(1) + "\" value=\"" + value + "\"/></data></cresnet>");
					}
				}
			},

			onSerialChanged:function (join, value) {
				//Not Currently Supported By Crestron
				/*
				var data;
				var id;
				if (this.initialized === true) {
				id = join.substring(1);

				data = "<cresnet><data  som=\"true\" eom=\"true\"><string id=\"" + id + "\" value=\"" + value + "\"/></data></cresnet>";
				this.sendData(data);
				}
				*/
			},

			onDigitalChanged:function (join, value) {
				if (this.initialized) {
					if (value === 1 || value === "1") {
						if (this.dJoin[join] === 1) {
							return;
						}
						this.dJoin[join] = 1;
						value = "true";
					} else {
						if (this.dJoin[join] === 0) {
							return;
						}
						this.dJoin[join] = 0;
						value = "false";
					}
					this.sendData("<cresnet><data><bool id=\"" + join.substring(1) + "\" value=\"" + value + "\" repeating=\"true\"/></data></cresnet>");
				}
			},

			// ------------------------------------------------------------------
			// Heartbeat management
			// ------------------------------------------------------------------
			sendHeartBeat:function () {
				if (this.updateComplete) {
					if (this.heartbeatCount++ > 2) {
						// After a few seconds without any answer, reset the connection only if another reset
						// is not already in progress
						if (this.connectionResetTimeout === 0) {
							if (CrestronMobile.debug) {
								CF.log("CrestronMobile: no response from Crestron for more than 5 seconds, resetting the connection");
							}
							this.heartbeatCount = 0;
							this.connection("reset");
						}
					} else {
						// Send heartbeat message to Crestron
						this.sendData("<cresnet><control><comm><heartbeatRequest></heartbeatRequest></comm></control></cresnet>");
					}
				}
			},

			// ------------------------------------------------------------------
			// Crestron messages processing
			// ------------------------------------------------------------------
			parseXML:function (xml) {
				if (!this.initialized && (xml.indexOf("string") >= 0 && xml.indexOf("value=\"\"") >= 0)) {
					return;
				}
				var parser = new window.DOMParser();
				xml = xml.substring(xml.indexOf("<?xml"));
				var tree = parser.parseFromString(xml, "text/xml");
				//Moved parser back to Parse function.  Possible memory leak causing crash when defined globally.
				//Also trying to clear the parser when I'm done with it so it doesn't stay resident.
				parser = undefined;
				if (tree === null) {
					return;
				}

				var updates = [];
				var join, index, valueNode, tempValue;
				var child, data, childTag, isUTF8;
				var dataElements = tree.getElementsByTagName("data");

				for (var i = 0; i < dataElements.length; i++) {
					data = dataElements[i];
					child = data.firstElementChild;
					isUTF8 = (data.getAttribute("enc") === "UTF-8");
					while (child !== null) {
						childTag = child.tagName;
						if (childTag === "bool") {
							//Found Digital(bool) Element
							index = child.getAttributeNode("id").nodeValue;
							join = "d" + index;
							tempValue = (child.getAttributeNode("value").nodeValue === "true") ? 1 : 0;
							if (!this.updateComplete || this.dJoin[join] !== tempValue) {
								if (this.initialized) {
									updates.push({join:join, value:tempValue});
								}
								this.dJoin[join] = tempValue;
							}

						} else if (childTag === "string") {
							//Found Serial(string) Element
							index = child.getAttributeNode("id").nodeValue;
							join = "s" + index;
							tempValue = child.getAttribute("value");
							if (tempValue === null) {
								if (child.firstChild !== null) {
									tempValue = child.firstChild.nodeValue;
								} else {
									tempValue = "";
								}
							}
							if (isUTF8) {
								tempValue = decodeURIComponent(escape(tempValue));
							}
							if (!this.updateComplete || this.sJoin[join] !== tempValue) {
								if (this.initialized) {
									updates.push({join:join, value:tempValue});
								}
								this.sJoin[join] = tempValue;
							}

						} else if (childTag === "i32") {
							//Found Analog(i32) Element
							index = child.getAttributeNode("id").nodeValue;
							join = "a" + index;
							valueNode = child.getAttributeNode("value");
							if (valueNode === null) {
								valueNode = child.firstChild;
							}
							tempValue = valueNode.value;
							if (!this.updateComplete || this.aJoin[join] !== tempValue) {
								if (this.initialized) {
									updates.push({join:join, value:tempValue});
								}
								this.aJoin[join] = tempValue;
							}
						}
						child = child.nextSibling;
					}
				}
				//Update Interface
				if (updates.length > 0) {
					CF.setJoins(updates, true);
				}
			},

			gotProgramReadyStatus: function(str) {
				// This is the first message we should receive upon connecting to Crestron
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: got program ready status " + str);
				}
				//Found Program Ready Message, send Connect Request to system
				this.clearConnectionResetTimeout();
				this.setLoadingMessageVisible(true);
				this.updateComplete = false;
				this.initialized = false;
				this.loggedIn = false;
				this.heartbeatCount = 0;		// reset heartbeatCount: this gives us 10s to log in
				this.resetRunningJoins();

				CF.send(this.systemName, "<cresnet><control><comm><connectRequest><passcode>" + this.password + "</passcode><mode isUnicodeSupported=\"true\"></mode></connectRequest></comm></control></cresnet>");
			},

			gotConnectResponse: function(str) {
				//Found Connect Response Message, validate response
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: got connect response " + str);
				}
				if (str.indexOf("<code>0</code>") > 0) {
					//Connection is good, send Update Request Message to system
					this.loggedIn = true;
					CF.send(this.systemName, "<cresnet><data><updateRequest></updateRequest></data></cresnet>");
				} else {
					this.connection("reset");
				}
			},

			gotEndOfUpdate: function(str) {
				// Update complete, send all current known join status to iViewer
				// and begin sending Heartbeat Message
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: got endOfUpdate " + str);
				}
				this.setLoadingMessageVisible(false);

				var join, initial = [];
				for (join in this.dJoin) {
					initial.push({join:join, value:this.dJoin[join]});
				}
				for (join in this.aJoin) {
					initial.push({join:join, value:this.aJoin[join]});
				}
				for (join in this.sJoin) {
					initial.push({join:join, value:this.sJoin[join]});
				}
				if (initial.length >= 0) {
					CF.setJoins(initial, true);
				}

				this.updateComplete = true;
				this.initialized = true;
				this.sendData("<cresnet><data><i32 id=\"17259\" value=\"" + this.orientation + "\"/></data></cresnet>");
			},

			gotHeartbeatResponse: function() {
				// Found Hearbeat Response Message
				this.setLoadingMessageVisible(false);
				this.updateComplete = true;
				this.initialized = true;
			},

			gotHeartbeatRequest: function(str) {
				if (CrestronMobile.debug) {
					CF.log("CrestronMobile: got heartbeat request " + str);
				}
				this.setLoadingMessageVisible(false);
				this.updateComplete = true;
				this.initialized = true;
			},

			gotDisconnectRequest: function() {
				this.setLoadingMessageVisible(true);
				this.updateComplete = false;
				this.initialized = false;
				this.loggedIn = false;
			},

			processFeedback:function (feedbackname, str) {
				this.heartbeatCount = 0;
				this.lastDataReceived = Date.now();

				if (str.indexOf("<programReady><status>") >= 0) {
					this.gotProgramReadyStatus(str);
				} else if (str.indexOf("<connectResponse>") >= 0) {
					this.gotConnectResponse(str);
				} else if (str.indexOf("endOfUpdate") >= 0) {
					this.gotEndOfUpdate(str);
				} else if (str.indexOf("</heartbeatResponse>") >= 0) {
					this.gotHeartbeatResponse();
				} else if (str.indexOf("<heartbeatRequest>") >= 0) {
					this.gotHeartbeatRequest(str);
				} else if (str.indexOf("<string") >= 0 || str.indexOf("<bool") >= 0 || str.indexOf("<i32") >= 0) {
					//Parse the updated values
					if (CrestronMobile.debug) {
						CF.log("CrestronMobile: got update " + str);
					}
					this.parseXML(str);
				} else if (str.indexOf("<disconnectRequest>") >= 0) {
					this.gotDisconnectRequest();
				}
			}
		};

		instance.initialize(config, guiDescription);
		return instance;
	}
};

CF.modules.push({
	name:"CrestronMobile",			// the name of this module
	setup:CrestronMobile.setup,		// the setup function to call before CF.userMain
	object:CrestronMobile,			// the `this' object for the setup function
	version:"v3.0-alpha"			// the version of this module
});
