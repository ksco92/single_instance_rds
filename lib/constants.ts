import {InstanceClass, InstanceSize, InstanceType} from 'aws-cdk-lib/aws-ec2';
import {Duration, RemovalPolicy} from 'aws-cdk-lib';

export const RDS_PORT = 5432;

export const APP_NAME = 'mycooldb';

export const DB_INSTANCE_TYPE = InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO);

export const DB_STORAGE_GIB = 20;

export const PASSWORD_ROTATION_INTERVAL = Duration.days(1);

export const REMOVAL_POLICY = RemovalPolicy.DESTROY;

export const BASTION_KEY_PAIR_NAME = 'plutus2-bastion';

export const MY_IP_ADDRESS = '98.97.35.0';
