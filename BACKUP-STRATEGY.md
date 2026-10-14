# Backup Strategy

## MongoDB Atlas Backups

MongoDB Atlas provides **automated backups** by default for M10+ clusters:

1. **Continuous Cloud Backup** (recommended):
   - Point-in-time recovery to the second
   - Retention: 30 days of continuous history + 7 daily snapshots
   - Enable in Atlas UI: **Backup → Continuous Cloud Backup**

2. **Periodic Snapshots**:
   - Daily snapshots retained for 35 days
   - Weekly snapshots retained for 12 weeks
   - Monthly snapshots retained for 12 months

## Self-Managed Backup Script

For self-hosted MongoDB or additional backup control:

```bash
#!/bin/bash
# Run daily via cron: 0 2 * * * /path/to/backup.sh

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups/mongodb"
MONGODB_URI="your-mongodb-uri-here"

mkdir -p $BACKUP_DIR
mongodump --uri="$MONGODB_URI" --out="$BACKUP_DIR/$DATE"
tar -czf "$BACKUP_DIR/backup_$DATE.tar.gz" -C "$BACKUP_DIR" "$DATE"
rm -rf "$BACKUP_DIR/$DATE"

# Keep only last 30 days of backups
find $BACKUP_DIR -name "backup_*.tar.gz" -mtime +30 -delete
```

## What to Back Up

| Data | Source | Frequency | Retention |
|------|--------|-----------|-----------|
| User accounts | `organizers`, `attendee` collections | Daily | 30 days |
| Events | `events` collection | Daily | 30 days |
| Attendees | `attendees` collection | Daily | 30 days |
| Photos | Google Drive (organizer's account) | N/A | Organizer's responsibility |
| Audit logs | Application logs | Daily | 90 days |

## Recovery Testing

- **Monthly**: Perform a restore test from backup to a staging environment
- **Quarterly**: Full disaster recovery drill (restore to new cluster)

## Environment Variables

Ensure these are backed up separately (not in the database):

- `MONGODB_URI`
- `JWT_SECRET`
- `GOOGLE_SERVICE_ACCOUNT_KEY`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `CLOUDINARY_*`
- `EMAIL_USER` / `EMAIL_PASSWORD`

Store these in a secure password manager or secrets vault (e.g., AWS Secrets Manager, HashiCorp Vault).