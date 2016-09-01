/// <reference path="../../../definitions/node.d.ts" />
/// <reference path="../../../definitions/vsts-task-lib.d.ts" />

import * as tl from 'vsts-task-lib/task';
import {ToolRunner, IExecOptions, IExecResult} from 'vsts-task-lib/toolrunner';
import * as auth from "./Authentication"
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';

import * as ngutil from "./Utility";

interface EnvironmentDictionary { [key: string]: string }

export interface NuGetEnvironmentSettings {
    authInfo: auth.NuGetAuthInfo;
    credProviderFolder: string;
    extensionsDisabled: boolean;
}

function prepareNuGetExeEnvironment(input: EnvironmentDictionary, settings: NuGetEnvironmentSettings): EnvironmentDictionary {
    var env: EnvironmentDictionary = {}
    var originalCredProviderPath: string;
    for (var e in input) {
        // NuGet.exe extensions only work with a single specific version of nuget.exe. This causes problems
        // whenever we update nuget.exe on the agent.
        if (e.toUpperCase() == "NUGET_EXTENSIONS_PATH") {
            if (settings.extensionsDisabled) {
                tl.warning(tl.loc("NGCommon_IgnoringNuGetExtensionsPath"))
                continue;
            } else {
                tl._writeLine(tl.loc("NGCommon_DetectedNuGetExtensionsPath", input[e]))
            }
        }

        if (e.toUpperCase() == 'NUGET_CREDENTIALPROVIDERS_PATH') {
            originalCredProviderPath = input[e];

            // will re-set this variable below
            continue;
        }

        env[e] = input[e];
    }

    var credProviderPath = settings.credProviderFolder || originalCredProviderPath;
    if (settings.credProviderFolder && originalCredProviderPath) {
        credProviderPath = settings.credProviderFolder + ";" + originalCredProviderPath;
    }

    env['VSS_NUGET_ACCESSTOKEN'] = settings.authInfo.accessToken;
    env['VSS_NUGET_URI_PREFIXES'] = settings.authInfo.uriPrefixes.join(";");
    env['NUGET_CREDENTIAL_PROVIDER_OVERRIDE_DEFAULT'] = 'true';

    if (credProviderPath) {
        tl.debug(`credProviderPath = ${credProviderPath}`);
        env['NUGET_CREDENTIALPROVIDERS_PATH'] = credProviderPath;
    }

    return env;
}

export class NuGetToolRunner extends ToolRunner {
    private _settings: NuGetEnvironmentSettings;

    constructor(nuGetExePath: string, settings: NuGetEnvironmentSettings) {
        if (os.platform() === 'win32' || !nuGetExePath.trim().toLowerCase().endsWith('.exe')) {
            super(nuGetExePath);
        }
        else {
            let monoPath = tl.which('mono', true);
            super(monoPath);
            this.pathArg(nuGetExePath);
        }

        this._settings = settings;
    }

    public execSync(options?: IExecOptions): IExecResult {
        options = options || <IExecOptions>{};
        options.env = prepareNuGetExeEnvironment(options.env || process.env, this._settings);
        return super.execSync(options);
    }

    public exec(options?: IExecOptions): Q.Promise<number> {
        options = options || <IExecOptions>{};
        options.env = prepareNuGetExeEnvironment(options.env || process.env, this._settings);
        return super.exec(options);
    }
}

export function createNuGetToolRunner(nuGetExePath: string, settings: NuGetEnvironmentSettings): NuGetToolRunner {
    let runner = new NuGetToolRunner(nuGetExePath, settings);
    runner.on('debug', message => tl.debug(message));
    return runner;
}

interface LocateOptions {
    /** if true, search along the system path in addition to the hard-coded NuGet tool paths */
    fallbackToSystemPath?: boolean;

    /** Array of filenames to use when searching for the tool. Defaults to the tool name. */
    toolFilenames?: string[];
}

function locateTool(tool: string, opts?: LocateOptions) {
    let searchPath = ["externals/nuget", "agent/Worker/Tools/NuGetCredentialProvider", "agent/Worker/Tools"];
    let agentRoot = tl.getVariable("Agent.HomeDirectory");

    opts = opts || {};
    opts.toolFilenames = opts.toolFilenames || [tool];

    tl.debug(`looking for tool ${tool}`)

    for (let thisVariant of opts.toolFilenames)
    {
        tl.debug(`looking for tool variant ${thisVariant}`);

        for (let possibleLocation of searchPath) {
            let fullPath = path.join(agentRoot, possibleLocation, thisVariant);
            tl.debug(`checking ${fullPath}`);
            if (tl.exist(fullPath)) {
                return fullPath;
            }
        }

        if (opts.fallbackToSystemPath) {
            tl.debug('Checking system path');
            let whichResult = tl.which(thisVariant);
            if (whichResult) {
                tl.debug(`found ${whichResult}`);
                return whichResult;
            }
        }

        tl.debug("not found");
    }

    return null;
}

export function locateNuGetExe(userNuGetExePath: string): string {
    if (userNuGetExePath) {
        if (os.platform() === "win32") {
            userNuGetExePath = ngutil.stripLeadingAndTrailingQuotes(userNuGetExePath);
        }

        tl.debug(`using user-supplied NuGet path ${userNuGetExePath}`);
        tl.checkPath(userNuGetExePath, 'NuGet');
        return userNuGetExePath;
    }

    var toolPath = locateTool('NuGet', {
        fallbackToSystemPath: os.platform() !== 'win32',
        toolFilenames: ['nuget.exe', 'NuGet.exe', 'nuget', 'NuGet']
    });

    
    if (!toolPath) {
        throw new Error(tl.loc("NGCommon_UnableToFindTool", 'NuGet'));
    }

    return toolPath;
}

function isHosted(): boolean {
    // not an ideal way to detect hosted, but there isn't a variable for it, and we can't make network calls from here
    // due to proxy issues.
    const collectionUri = tl.getVariable("System.TeamFoundationCollectionUri");
    const parsedCollectionUri = url.parse(collectionUri);
    return /\.visualstudio\.com$/i.test(parsedCollectionUri.hostname);
}

// Currently, there is a race condition of some sort that causes nuget to not send credentials sometimes
// when using the credential provider.
// Unfortunately, on on-premises TFS, we must use credential provider to override NTLM auth with the build
// identity's token.
// Therefore, we are enabling credential provider on on-premises and disabling it on hosted. We allow for test
// instances by an override variable.

export function isCredentialProviderEnabled(): boolean {
    // set NuGet.ForceEnableCredentialProvider to "true" to force allowing the credential provider flow, "false"
    // to force *not* allowing the credential provider flow, or unset/anything else to fall through to the 
    // hosted environment detection logic
    const credentialProviderOverrideFlag = tl.getVariable("NuGet.ForceEnableCredentialProvider");
    if (credentialProviderOverrideFlag === "true") {
        tl.debug("Credential provider is force-enabled for testing purposes.");
        return true;
    }

    if (credentialProviderOverrideFlag === "false") {
        tl.debug("Credential provider is force-disabled for testing purposes.");
        return false;
    }
    
    if (isHosted()) {
        tl.debug("Credential provider is disabled on hosted.");
        return false;
    }
    else {
        tl.debug("Credential provider is enabled.")
        return true;
    }
}

export function isCredentialConfigEnabled(): boolean {
    // set NuGet.ForceEnableCredentialConfig to "true" to force allowing config-based credential flow, "false"
    // to force *not* allowing config-based credential flow, or unset/anything else to fall through to the 
    // hosted environment detection logic
    const credentialConfigOverrideFlag = tl.getVariable("NuGet.ForceEnableCredentialConfig");
    if (credentialConfigOverrideFlag === "true") {
        tl.debug("Credential config is force-enabled for testing purposes.");
        return true;
    }

    if (credentialConfigOverrideFlag === "false") {
        tl.debug("Credential config is force-disabled for testing purposes.");
        return false;
    }
    
    // credentials in config will always fail for on-prem
    if (!isHosted()) {
        tl.debug("Credential config is disabled on on-premises TFS.");
        return false;
    }
    else {
        tl.debug("Credential config is enabled.")
        return true;
    }
}

export function locateCredentialProvider(): string {
    const credentialProviderLocation = locateTool('CredentialProvider.TeamBuild.exe');
    if(!credentialProviderLocation) {
        tl.debug("Credential provider is not present.");
        return null;
    }

    return isCredentialProviderEnabled() ? credentialProviderLocation : null;
}

