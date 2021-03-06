import _ from 'lodash';
import { BaseDriver } from 'appium-base-driver';
import EspressoRunner from './espresso-runner';
import { fs } from 'appium-support';
import logger from './logger';
import commands from './commands';
import { DEFAULT_ADB_PORT } from 'appium-adb';
import { androidHelpers, androidCommands } from 'appium-android-driver';
import desiredCapConstraints from './desired-caps';
import { version } from '../../package.json'; // eslint-disable-line import/no-unresolved
import { findAPortNotInUse } from 'portscanner';


// TODO merge our own helpers onto this later
const helpers = androidHelpers;

// The range of ports we can use on the system for communicating to the
// Espresso HTTP server on the device
const SYSTEM_PORT_RANGE = [8300, 8399];

// This is the port that the espresso server listens to on the device. We will
// forward one of the ports above on the system to this port on the device.
const DEVICE_PORT = 6791;

// NO_PROXY contains the paths that we never want to proxy to espresso server.
// TODO:  Add the list of paths that we never want to proxy to espresso server.
// TODO: Need to segregate the paths better way using regular expressions wherever applicable.
// (Not segregating right away because more paths to be added in the NO_PROXY list)
const NO_PROXY = [
  ['GET', new RegExp('^/session/(?!.*/)')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/current_activity')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/current_package')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/display_density')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/is_keyboard_shown')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/system_bars')],
  ['GET', new RegExp('^/session/[^/]+/appium/device/system_time')],
  ['GET', new RegExp('^/session/[^/]+/context')],
  ['GET', new RegExp('^/session/[^/]+/contexts')],
  ['GET', new RegExp('^/session/[^/]+/log/types')],
  ['GET', new RegExp('^/session/[^/]+/network_connection')],
  ['GET', new RegExp('^/session/[^/]+/url')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/background')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/close')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/launch')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/reset')],
  ['POST', new RegExp('^/session/[^/]+/appium/app/strings')],
  ['POST', new RegExp('^/session/[^/]+/appium/compare_images')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/activate_app')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/app_installed')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/app_state')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/hide_keyboard')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/install_app')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/is_locked')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/lock')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/pull_file')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/push_file')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/remove_app')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/terminate_app')],
  ['POST', new RegExp('^/session/[^/]+/appium/device/unlock')],
  ['POST', new RegExp('^/session/[^/]+/appium/getPerformanceData')],
  ['POST', new RegExp('^/session/[^/]+/appium/performanceData/types')],
  ['POST', new RegExp('^/session/[^/]+/appium/start_recording_screen')],
  ['POST', new RegExp('^/session/[^/]+/appium/stop_recording_screen')],
  ['POST', new RegExp('^/session/[^/]+/context')],
  ['POST', new RegExp('^/session/[^/]+/execute')],
  ['POST', new RegExp('^/session/[^/]+/execute/async')],
  ['POST', new RegExp('^/session/[^/]+/execute/sync')],
  ['POST', new RegExp('^/session/[^/]+/execute_async')],
  ['POST', new RegExp('^/session/[^/]+/ime/[^/]+')],
  ['POST', new RegExp('^/session/[^/]+/log')],
  ['POST', new RegExp('^/session/[^/]+/network_connection')],
  ['POST', new RegExp('^/session/[^/]+/timeouts')],
  ['POST', new RegExp('^/session/[^/]+/url')],
];

const APP_EXTENSION = '.apk';


class EspressoDriver extends BaseDriver {
  constructor (opts = {}, shouldValidateCaps = true) {
    // `shell` overwrites adb.shell, so remove
    delete opts.shell;

    super(opts, shouldValidateCaps);
    this.locatorStrategies = [
      'id',
      'class name',
      'accessibility id',
    ];
    this.desiredCapConstraints = desiredCapConstraints;
    this.espresso = null;
    this.jwpProxyActive = false;
    this.defaultIME = null;
    this.jwpProxyAvoid = NO_PROXY;

    this.apkStrings = {}; // map of language -> strings obj
  }

  async createSession (...args) {
    try {
      // TODO handle otherSessionData for multiple sessions
      let [sessionId, caps] = await super.createSession(...args);

      let serverDetails = {
        platform: 'LINUX',
        webStorageEnabled: false,
        takesScreenshot: true,
        javascriptEnabled: true,
        databaseEnabled: false,
        networkConnectionEnabled: true,
        locationContextEnabled: false,
        warnings: {},
        desired: Object.assign({}, this.caps)
      };

      this.caps = Object.assign(serverDetails, this.caps);

      let defaultOpts = {
        fullReset: false,
        autoLaunch: true,
        adbPort: DEFAULT_ADB_PORT,
        androidInstallTimeout: 90000
      };
      _.defaults(this.opts, defaultOpts);

      if (this.opts.reboot) {
        this.setAvdFromCapabilities(caps);
        this.addWipeDataToAvdArgs();
      }

      if (this.opts.app) {
        // find and copy, or download and unzip an app url or path
        this.opts.app = await this.helpers.configureApp(this.opts.app, APP_EXTENSION);
        await this.checkAppPresent();
      } else if (this.appOnDevice) {
        // the app isn't an actual app file but rather something we want to
        // assume is on the device and just launch via the appPackage
        logger.info(`App file was not listed, instead we're going to run ` +
            `${this.opts.appPackage} directly on the device`);
        await this.checkPackagePresent();
      }

      this.opts.systemPort = this.opts.systemPort || await findAPortNotInUse(SYSTEM_PORT_RANGE[0], SYSTEM_PORT_RANGE[1]);
      this.opts.adbPort = this.opts.adbPort || DEFAULT_ADB_PORT;
      await this.startEspressoSession();
      return [sessionId, caps];
    } catch (e) {
      await this.deleteSession();
      throw e;
    }
  }

  get driverData () {
    // TODO fille out resource info here
    return {};
  }

  isEmulator () {
    return !!this.opts.avd;
  }

  // TODO this method is duplicated from uiautomator2-driver; consolidate
  setAvdFromCapabilities (caps) {
    if (this.opts.avd) {
      logger.info('avd name defined, ignoring device name and platform version');
    } else {
      if (!caps.deviceName) {
        logger.errorAndThrow('avd or deviceName should be specified when reboot option is enables');
      }
      if (!caps.platformVersion) {
        logger.errorAndThrow('avd or platformVersion should be specified when reboot option is enabled');
      }
      let avdDevice = caps.deviceName.replace(/[^a-zA-Z0-9_.]/g, "-");
      this.opts.avd = `${avdDevice}__${caps.platformVersion}`;
    }
  }

  // TODO this method is duplicated from uiautomator2-driver; consolidate
  addWipeDataToAvdArgs () {
    if (!this.opts.avdArgs) {
      this.opts.avdArgs = '-wipe-data';
    } else if (!this.opts.avdArgs.toLowerCase().includes('-wipe-data')) {
      this.opts.avdArgs += ' -wipe-data';
    }
  }

  // TODO much of this logic is duplicated from uiautomator2
  async startEspressoSession () {

    logger.info(`EspressoDriver version: ${version}`);

    if (!this.opts.javaVersion) {
      this.opts.javaVersion = await helpers.getJavaVersion();
    }

    // get device udid for this session
    let {udid, emPort} = await helpers.getDeviceInfoFromCaps(this.opts);
    this.opts.udid = udid;
    this.opts.emPort = emPort;

    // now that we know our java version and device info, we can create our
    // ADB instance
    this.adb = await androidHelpers.createADB(this.opts);
    // get appPackage et al from manifest if necessary
    let appInfo = await helpers.getLaunchInfo(this.adb, this.opts);
    // and get it onto our 'opts' object so we use it from now on
    Object.assign(this.opts, appInfo);

    // https://github.com/appium/appium-espresso-driver/issues/72
    await androidHelpers.pushSettingsApp(this.adb);
    if (await this.adb.isAnimationOn()) {
      try {
        await this.adb.setAnimationState(false);
        this.wasAnimationEnabled = true;
      } catch (err) {
        logger.warn(`Unable to turn off animations: ${err.message}`);
      }
    }

    // set actual device name, udid
    this.caps.deviceName = this.adb.curDeviceId;
    this.caps.deviceUDID = this.opts.udid;

    // set up the modified espresso server etc
    this.initEspressoServer();
    // start an avd, set the language/locale, pick an emulator, etc...
    // TODO with multiple devices we'll need to parameterize this
    await helpers.initDevice(this.adb, this.opts);
    // Further prepare the device by forwarding the espresso port
    logger.debug(`Forwarding Espresso Server port ${DEVICE_PORT} to ${this.opts.systemPort}`);
    await this.adb.forwardPort(this.opts.systemPort, DEVICE_PORT);

    if (!this.opts.skipUnlock) {
      // unlock the device to prepare it for testing
      await helpers.unlock(this, this.adb, this.caps);
    } else {
      logger.debug(`'skipUnlock' capability set, so skipping device unlock`);
    }
    // If the user sets autoLaunch to false, they are responsible for initAUT() and startAUT()
    if (this.opts.autoLaunch) {
      // set up app under test
      // prepare our actual AUT, get it on the device, etc...
      await this.initAUT();
    }
    //Adding AUT package name in the capabilities if package name not exist in caps
    if (!this.caps.appPackage) {
      this.caps.appPackage = appInfo.appPackage;
    }
    if (!this.caps.appActivity) {
      // fully qualify the appActivity
      let appActivity = appInfo.appActivity;
      if (!appInfo.appActivity.startsWith(this.caps.appPackage)) {
        appActivity = `${this.caps.appPackage}${appActivity.startsWith('.') ? '' : '.'}${appActivity}`;
        logger.warn(`Adjusted appActivity to fully qualified version: '${appActivity}'`);
      }
      this.caps.appActivity = appActivity;
    }

    // launch espresso and wait till its online and we have a session
    await this.espresso.startSession(this.caps);

    // now that everything has started successfully, turn on proxying so all
    // subsequent session requests go straight to/from espresso
    this.jwpProxyActive = true;

    await this.addDeviceInfoToCaps();
  }

  async addDeviceInfoToCaps () {
    const {
      apiVersion,
      platformVersion,
      manufacturer,
      model,
      realDisplaySize,
      displayDensity,
    } = await this.mobileGetDeviceInfo();
    this.caps.deviceApiLevel = parseInt(apiVersion, 10);
    this.caps.platformVersion = platformVersion;
    this.caps.deviceScreenSize = realDisplaySize;
    this.caps.deviceScreenDensity = displayDensity;
    this.caps.deviceModel = model;
    this.caps.deviceManufacturer = manufacturer;
  }

  initEspressoServer () {
    // now that we have package and activity, we can create an instance of
    // espresso with the appropriate data
    this.espresso = new EspressoRunner({
      host: this.opts.host || 'localhost',
      systemPort: this.opts.systemPort,
      devicePort: DEVICE_PORT,
      adb: this.adb,
      apk: this.opts.app,
      tmpDir: this.opts.tmpDir,
      appPackage: this.opts.appPackage,
      appActivity: this.opts.appActivity,
      forceEspressoRebuild: !!this.opts.forceEspressoRebuild,
      serverLaunchTimeout: this.opts.espressoServerLaunchTimeout,
    });
    this.proxyReqRes = this.espresso.proxyReqRes.bind(this.espresso);
  }

  // TODO this method is mostly duplicated from uiautomator2
  async initAUT () {
    // set the localized strings for the current language from the apk
    // TODO: incorporate changes from appium#5308 which fix a race cond-
    // ition bug in old appium and need to be replicated here
    // this.apkStrings[this.opts.language] = await androidHelpers.pushStrings(
    //     this.opts.language, this.adb, this.opts);

    if (!this.opts.app) {
      if (this.opts.fullReset) {
        logger.errorAndThrow('Full reset requires an app capability, use fastReset if app is not provided');
      }
      logger.debug('No app capability. Assuming it is already on the device');
      if (this.opts.fastReset) {
        await helpers.resetApp(this.adb, this.opts);
      }
    }

    if (!this.opts.skipUninstall) {
      await this.adb.uninstallApk(this.opts.appPackage);
    }
    if (!this.opts.noSign) {
      let signed = await this.adb.checkApkCert(this.opts.app, this.opts.appPackage);
      if (!signed && this.opts.app) {
        await this.adb.sign(this.opts.app, this.opts.appPackage);
      }
    }
    if (this.opts.app) {
      await helpers.installApk(this.adb, this.opts);
    }
    await this.espresso.installTestApk();
  }

  async deleteSession () {
    logger.debug('Deleting espresso session');
    if (this.espresso) {
      if (this.jwpProxyActive) {
        await this.espresso.deleteSession();
      }
      this.espresso = null;
    }
    this.jwpProxyActive = false;

    // TODO below logic is duplicated from uiautomator2
    if (this.adb) {
      if (this.wasAnimationEnabled) {
        try {
          await this.adb.setAnimationState(true);
        } catch (err) {
          logger.warn(`Unable to reset animation: ${err.message}`);
        }
      }
      if (this.opts.unicodeKeyboard && this.opts.resetKeyboard &&
          this.defaultIME) {
        logger.debug(`Resetting IME to '${this.defaultIME}'`);
        await this.adb.setIME(this.defaultIME);
      }
      if (this.opts.appPackage) {
        await this.adb.forceStop(this.opts.appPackage);
      }
      if (this.opts.fullReset && !this.opts.skipUninstall && !this.appOnDevice) {
        logger.debug(`FULL_RESET set to 'true', Uninstalling '${this.opts.appPackage}'`);
        await this.adb.uninstallApk(this.opts.appPackage);
      }
      await this.adb.stopLogcat();
      if (this.opts.reboot) {
        let avdName = this.opts.avd.replace('@', '');
        logger.debug(`closing emulator '${avdName}'`);
        await this.adb.killEmulator(avdName);
      }
    }
    await super.deleteSession();
    if (this.opts.systemPort !== undefined) {
      try {
        await this.adb.removePortForward(this.opts.systemPort);
      } catch (error) {
        logger.warn(`Unable to remove port forward '${error.message}'`);
        //Ignore, this block will also be called when we fall in catch block
        // and before even port forward.
      }
    }
  }

  // TODO method is duplicated from uiautomator2
  async checkAppPresent () {
    logger.debug('Checking whether app is actually present');
    if (!(await fs.exists(this.opts.app))) {
      logger.errorAndThrow(`Could not find app apk at '${this.opts.app}'`);
    }
  }

  proxyActive (sessionId) {
    super.proxyActive(sessionId);

    // we always have an active proxy to the espresso server
    return true;
  }

  canProxy (sessionId) {
    super.canProxy(sessionId);

    // we can always proxy to the espresso server
    return true;
  }

  getProxyAvoidList (sessionId) {
    super.getProxyAvoidList(sessionId);
    this.jwpProxyAvoid = NO_PROXY;
    return this.jwpProxyAvoid;
  }
}

// first add the android-driver commands which we will fall back to
for (let [cmd, fn] of _.toPairs(androidCommands)) {
  // we do some different/special things with these methods
  if (!_.includes(['defaultWebviewName'], cmd)) {
    EspressoDriver.prototype[cmd] = fn;
  }
}

// then overwrite with any espresso-specific commands
for (let [cmd, fn] of _.toPairs(commands)) {
  EspressoDriver.prototype[cmd] = fn;
}

export { EspressoDriver };
export default EspressoDriver;
