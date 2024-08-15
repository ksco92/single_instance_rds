#!/usr/bin/env node
import 'source-map-support/register';
import {App} from 'aws-cdk-lib';
import SingleInstanceRdsStack from '../lib/single-instance-rds-stack';

const app = new App();
new SingleInstanceRdsStack(app, 'SingleInstanceRdsStack', {
    appName: 'mycooldb',
    bastionKeyPairName: 'single-rds-bastion',
    myIpAddress: '1.2.3.4',
});
