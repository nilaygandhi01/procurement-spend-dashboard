output "postgresql_databases" {
  description = "A list of PostgreSQL database(s)"
  value       = module.lrah.postgresql_databases
}

output "postgresql_roles" {
  description = "A list of PostgreSQL database role(s)"
  value       = module.lrah.postgresql_roles
  sensitive   = true
}

output "mysql_databases" {
  description = "A list of MySQL database(s)"
  value       = module.lrah.mysql_databases
}

output "mysql_roles" {
  description = "A list of MySQL database role(s)"
  value       = module.lrah.mysql_roles
  sensitive   = true
}

output "s3_buckets" {
  description = "A list of created S3 bucket(s)"
  value       = module.lrah.s3_buckets
}

output "sqs_queues" {
  description = "A list of created SQS queue(s)"
  value       = module.lrah.sqs_queues
}

output "opensearch_domains" {
  description = "A list of created Opensearch domain(s)"
  value       = module.lrah.opensearch_domains
}

output "sa_role" {
  description = "IAM role for eks service account"
  value       = module.lrah.sa_role
}

output "elasticaches" {
  description = "A list of created elasticache(s)"
  value       = module.lrah.elasticaches
}
