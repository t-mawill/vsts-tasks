import Q = require('q');
import tl = require('vsts-task-lib/task');
import vstsWebApi = require('vso-node-api/WebApi');

const fs = require('fs');
const JSZip  = require('jszip');
const xmlreader = require('xmlreader');
const httpm = require('vso-node-api/HttpClient');
const restm = require('vso-node-api/RestClient');

export interface PackageBuildMetadata {
    PackageName: string;
    ProtocolType: string;
    BuildId: string;
    CommitId: string;
    BuildCollectionId: string;
    BuildProjectId: string;
    RepositoryId: string;
    BuildAccountId: string; //NOTE: NULL for on prem, must set this value for hosted!
    OriginalPackageVersion: string;
}

export interface PackageMetadata {
    Name: string;
    Version: string;
}

function getNuspec(packageFile: string): Q.Promise<string> {
    var defer = Q.defer<string>();    
    fs.readFile(packageFile, (err, data) => { //read packageFile
        JSZip.loadAsync(data) //unzip nupkg
        .then(nupkg => {
            return nupkg.file(/\.nuspec/)[0].async('string') //read nuspec (NOTE: reads the first nuspec found in a nupkg)
            .then(nuspec => {
                nuspec = nuspec.trim(); //trim whitespace
                defer.resolve(nuspec);
            });
        });
    });
    return defer.promise;
}

export function getPackageMetadata(packageFile: string): Q.Promise<PackageMetadata> {
    var defer = Q.defer<PackageMetadata>(); 
    getNuspec(packageFile)
    .then(nuspec => {
        xmlreader.read(nuspec, (err, res) => {
            defer.resolve({
                'Name': res.package.metadata.id.text(),
                'Version': res.package.metadata.version.text()
            });
        });
    });
    return defer.promise;
}

export function getFeedName(feedUrl: string): string {
    var url = feedUrl.split('/');
    var nextValueIsFeedName = false;
    for (var value of url) {
        if (nextValueIsFeedName) {
            return value;
        }
        if (value == '_packaging') {
            nextValueIsFeedName = true;
        } 
    }
    return null;
}

export function post(packageBuildMetadata: PackageBuildMetadata, url: string, accessToken: string): Q.Promise<PackageMetadata> {
    var defer = Q.defer<PackageMetadata>();
    var httpClient = new httpm.HttpClient('hello', [vstsWebApi.getBearerHandler(accessToken)]); //NOTE: first arg is user agent... should this be a value? NULL? 
    var restClient = new restm.RestClient(httpClient);

    tl.debug('POST request URL: ' + url);
    tl.debug('POST request body: ' + JSON.stringify(packageBuildMetadata));
    restClient.create(url, '3.0-preview', packageBuildMetadata, null, null, (err, statusCode, response) => {
        if (err) {
            err.statusCode = statusCode;
            defer.reject(err);
        }
        else {
            defer.resolve(response);
        }
    });
    return defer.promise;
}
