/// <reference path='../../definitions/node.d.ts'/>
/// <reference path='../../definitions/Q.d.ts' />
/// <reference path='../../definitions/vsts-task-lib.d.ts' />
/// <reference path='../../definitions/nuget-task-common.d.ts' />

import path = require('path');
import Q = require('q');
import tl = require('vsts-task-lib/task');
import toolrunner = require('vsts-task-lib/toolrunner');
import util = require('util');

import buildMetadataHelpers = require('nuget-task-common/BuildMetadataHelpers');
import locationHelpers = require('nuget-task-common/LocationHelpers');
import * as ngToolRunner from 'nuget-task-common/NuGetToolRunner';
import * as nutil from 'nuget-task-common/Utility';
import * as auth from 'nuget-task-common/Authentication';
import {NuGetConfigHelper} from 'nuget-task-common/NuGetConfigHelper';
import * as locationApi from 'nuget-task-common/LocationApi';
import * as os from 'os';

class PublishOptions {
    constructor(
        public nuGetPath: string,
        public feedUri: string,
        public apiKey: string,
        public configFile: string,
        public verbosity: string,
        public extraArgs: string,
        public environment: ngToolRunner.NuGetEnvironmentSettings
    ) { }
}

async function main(): Promise<void> {
    let buildIdentityDisplayName: string = null;
    let buildIdentityAccount: string = null;
    let packageBuildMetadata = null;
    try {

        tl.setResourcePath(path.join(__dirname, 'task.json'));

        //read inputs
        var searchPattern = tl.getPathInput('searchPattern', true, false);
        var filesList = nutil.resolveFilterSpec(searchPattern, tl.getVariable('System.DefaultWorkingDirectory') || process.cwd());       
        for (let packageFile of filesList) {
            if (!tl.stats(packageFile).isFile()) {
                throw new Error(tl.loc('NotARegularFile', packageFile));
            }  
        }
        var connectedServiceName = tl.getInput('connectedServiceName');
        var internalFeedUri = tl.getInput('feedName');
        var nuGetAdditionalArgs = tl.getInput('nuGetAdditionalArgs');
        var verbosity = tl.getInput('verbosity');
        var preCredProviderNuGet = tl.getBoolInput('preCredProviderNuGet');

        var nuGetFeedType = tl.getInput('nuGetFeedType') || 'external';
        // make sure the feed type is an expected one
        var normalizedNuGetFeedType = ['internal', 'external'].find(x => nuGetFeedType.toUpperCase() == x.toUpperCase());
        if (!normalizedNuGetFeedType) {
            throw new Error(tl.loc('UnknownFeedType', nuGetFeedType))
        }

        nuGetFeedType = normalizedNuGetFeedType;

        // due to a bug where we accidentally allowed nuGetPath to be surrounded by quotes before,
        // locateNuGetExe() will strip them and check for existence there.
        var userNuGetPath = tl.getPathInput('nuGetPath', false, false);
        if (!tl.filePathSupplied('nuGetPath')) {
            userNuGetPath = null;
        }

        var serviceUri = tl.getEndpointUrl('SYSTEMVSSCONNECTION', false);

        //find nuget location to use
        var nuGetPathToUse = ngToolRunner.locateNuGetExe(userNuGetPath);
        var credProviderPath = ngToolRunner.locateCredentialProvider();

        var credProviderDir: string = null;
        if (credProviderPath) {
            credProviderDir = path.dirname(credProviderPath)
        }
        else {
            tl._writeLine(tl.loc('NoCredProviderOnAgent'));
        }

        var accessToken = auth.getSystemAccessToken();     

        /*
        BUG: HTTP calls to access the location service currently do not work for customers behind proxies.
        locationHelpers.getNuGetConnectionData(serviceUri, accessToken)
            .then(connectionData => {
                buildIdentityDisplayName = locationHelpers.getIdentityDisplayName(connectionData.authorizedUser);
                buildIdentityAccount = locationHelpers.getIdentityAccount(connectionData.authorizedUser);
        
                tl._writeLine(tl.loc('ConnectingAs', buildIdentityDisplayName, buildIdentityAccount));
                return connectionData;
            })
            .then(locationHelpers.getAllAccessMappingUris)
            .fail(err => {
                if (err.code && err.code == 'AreaNotFoundInSps') {
                    tl.warning(tl.loc('CouldNotFindNuGetService'))
                    return <string[]>[];
                }
        
                throw err;
            })*/
        let urlPrefixes = await locationHelpers.assumeNuGetUriPrefixes(serviceUri);

        tl.debug(`discovered URL prefixes: ${urlPrefixes}`);

        // Note to readers: This variable will be going away once we have a fix for the location service for
        // customers behind proxies
        let testPrefixes = tl.getVariable('NuGetTasks.ExtraUrlPrefixesForTesting');
        if (testPrefixes) {
            urlPrefixes = urlPrefixes.concat(testPrefixes.split(';'));
            tl.debug(`all URL prefixes: ${urlPrefixes}`)
        }

        const authInfo = new auth.NuGetAuthInfo(urlPrefixes, accessToken);

        var environmentSettings: ngToolRunner.NuGetEnvironmentSettings = {
            authInfo: authInfo,
            credProviderFolder: credProviderDir,
            extensionsDisabled: !userNuGetPath
        }

        var configFile = null;
        var apiKey: string;
        var feedUri: string;
        var credCleanup = () => { return };
        if (nuGetFeedType == 'internal') {
            if (!ngToolRunner.isCredentialConfigEnabled()) {
                tl.debug('Not configuring credentials in nuget.config');
            }
            else if (!credProviderDir || (userNuGetPath && preCredProviderNuGet)) {
                var nuGetConfigHelper = new NuGetConfigHelper(nuGetPathToUse, null, authInfo, environmentSettings);
                nuGetConfigHelper.setSources([{ feedName: 'internalFeed', feedUri: internalFeedUri }]);
                configFile = nuGetConfigHelper.tempNugetConfigPath;
                credCleanup = () => tl.rmRF(nuGetConfigHelper.tempNugetConfigPath, true);
            }

            apiKey = 'VSTS';
            feedUri = internalFeedUri;
        }
        else {
            feedUri = tl.getEndpointUrl(connectedServiceName, false);
            var externalAuth = tl.getEndpointAuthorization(connectedServiceName, false);
            apiKey = externalAuth.parameters['password'];
        }

        try {
            var publishOptions = new PublishOptions(
                nuGetPathToUse,
                feedUri,
                apiKey,
                configFile,
                verbosity,
                nuGetAdditionalArgs,
                environmentSettings);

            var result = Q({});
            for (const packageFile of filesList) {
                await publishPackageAsync(packageFile, publishOptions);
                
                // POST package build metadata to feed service
                let packageMetadata = await buildMetadataHelpers.getPackageMetadata(packageFile);
                packageBuildMetadata = {
                    'PackageName': packageMetadata.Name,
                    'ProtocolType': 'NuGet',
                    'BuildId': tl.getVariable('Build.BuildId'),
                    'CommitId': tl.getVariable('Build.SourceVersion'),
                    'BuildCollectionId': tl.getVariable('System.CollectionId'),
                    'BuildProjectId': tl.getVariable('System.TeamProjectId'),
                    'RepositoryId': tl.getVariable('Build.Repository.Id'), 
                    'BuildAccountId': null, //NOTE: NULL for on prem, must set this value for hosted!
                    'OriginalPackageVersion': packageMetadata.Version
                };  

                if (nuGetFeedType == 'internal') {
                    tl._writeLine('HELLO HELLO HELLO');
                    var baseUrl = 'http://pkg-styx:8080/tfs/DefaultCollection'; //TODO: this is hard coded!
                    var area = '/_apis/Packaging';
                    var service = '/Feeds/' + buildMetadataHelpers.getFeedName(internalFeedUri);
                    var resource = '/PackageRelationships/Builds';
                    var url = baseUrl + area + service + resource; 
                    buildMetadataHelpers.post(packageBuildMetadata, url, accessToken)
                    .then(response => {
                        tl._writeLine('POST build metadata sucessful.');
                        tl.debug(JSON.stringify(response));
                        return response;
                    })
                    .fail(err => {
                        tl._writeLine('POST build metadata failed.');
                        tl.debug(err);
                    })  
                }
            }
        } finally {
            credCleanup()
        }

        tl.setResult(tl.TaskResult.Succeeded, tl.loc('PackagesPublishedSuccessfully'));

    } catch (err) {
        tl.error(err);

        if (buildIdentityDisplayName || buildIdentityAccount) {
            tl.warning(tl.loc('BuildIdentityPermissionsHint', buildIdentityDisplayName, buildIdentityAccount));
        }

        tl.setResult(tl.TaskResult.Failed, tl.loc('PackagesFailedToPublish'))
    }
}

main();

function publishPackageAsync(packageFile: string, options: PublishOptions): Q.Promise<number> {
    var nugetTool = ngToolRunner.createNuGetToolRunner(options.nuGetPath, options.environment);
    nugetTool.arg('push')

    nugetTool.arg('-NonInteractive');

    nugetTool.pathArg(packageFile);

    nugetTool.arg(['-Source', options.feedUri]);

    nugetTool.argIf(options.apiKey, ['-ApiKey', options.apiKey]);

    if (options.configFile) {
        nugetTool.arg('-ConfigFile');
        nugetTool.pathArg(options.configFile);
    }

    if (options.verbosity && options.verbosity != '-') {
        nugetTool.arg('-Verbosity');
        nugetTool.arg(options.verbosity);
    }

    if (options.extraArgs) {
        nugetTool.argString(options.extraArgs);
    }

    return nugetTool.exec();
}